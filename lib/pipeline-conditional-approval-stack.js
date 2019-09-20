const cdk = require("@aws-cdk/core");
const step = require("@aws-cdk/aws-stepfunctions");
const tasks = require("@aws-cdk/aws-stepfunctions-tasks");
const lambda = require("@aws-cdk/aws-lambda");
const iam = require("@aws-cdk/aws-iam");

const getLambdaAsset = path => {
  if (process.env.MOCK_LAMBDA_ASSET) {
    return lambda.Code.asset("../stub");
  } else {
    return lambda.Code.asset(path);
  }
};

class PipelineConditionalApprovalStack extends cdk.Stack {
  /**
   *
   * @param {cdk.Construct} scope
   * @param {string} id
   * @param {cdk.StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    this.autoApproveEvaluationLambda = new lambda.Function(
      this,
      "AutoApproveEvaluate",
      {
        functionName: "auto-approval-evaluation",
        runtime: lambda.Runtime.NODEJS_10_X,
        handler: "evaluate.handler",
        code: getLambdaAsset("./lambda"),
        timeout: cdk.Duration.seconds(60)
      }
    );

    this.autoApprovalLambda = new lambda.Function(this, "AutoApprove", {
      functionName: "auto-approval",
      runtime: lambda.Runtime.NODEJS_10_X,
      handler: "approve.handler",
      code: getLambdaAsset("./lambda"),
      timeout: cdk.Duration.seconds(60)
    });

    const evaluateRequestTask = new step.Task(
      this,
      "Check if should be Auto Approved",
      {
        task: new tasks.InvokeFunction(this.autoApproveEvaluationLambda)
      }
    );

    const autoApproveTask = new step.Task(this, "Auto Approve", {
      task: new tasks.InvokeFunction(this.autoApprovalLambda)
    });
    autoApproveTask.addRetry({
      errors: ["NoTokenError"],
      maxAttempts: 8
    });

    const noAutoApprove = new step.Pass(this, "No Auto Approval");

    const wait30 = new step.Wait(this, "Wait30", {
      time: step.WaitTime.duration(cdk.Duration.seconds(30))
    });

    const stepFuncDefinition = evaluateRequestTask.next(
      new step.Choice(this, "AutoApprove?")
        .when(
          step.Condition.booleanEquals("$.autoApprove", true),
          wait30.next(autoApproveTask)
        )
        .otherwise(noAutoApprove)
    );

    this.conditionalApprovalStepFunc = new step.StateMachine(
      this,
      "ConditionalApprovalStepFunction",
      {
        stateMachineName: "conditional-approval",
        definition: stepFuncDefinition
      }
    );

    this.startStepFuncLambda = new lambda.Function(this, "StartStepFunc", {
      functionName: "start-conditional-approval",
      runtime: lambda.Runtime.NODEJS_10_X,
      handler: "startEvalStep.handler",
      code: getLambdaAsset("./lambda"),
      environment: {
        STEP_FUNCTION_ARN: this.conditionalApprovalStepFunc.stateMachineArn
      },
      timeout: cdk.Duration.seconds(30)
    });

    this.startStepFuncLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["codepipeline:PutJobSuccessResult"],
        resources: "*"
      })
    );

    this.conditionalApprovalStepFunc.grantStartExecution(
      this.startStepFuncLambda
    );

    this.autoApproveEvaluationLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: "*"
      })
    );

    this.autoApproveEvaluationLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cloudformation:CreateChangeSet",
          "cloudformation:DescribeChangeSet",
          "cloudformation:DeleteChangeSet",
          "cloudformation:DescribeStacks"
        ],
        resources: "*"
      })
    );

    this.autoApprovalLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["codepipeline:GetPipelineState"],
        resources: "*"
      })
    );

    this.autoApprovalLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["codepipeline:PutApprovalResult"],
        resources: "*"
      })
    );
  }
}

module.exports = { PipelineConditionalApprovalStack };
