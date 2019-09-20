const AWS = require("aws-sdk");

const transformCodePipelineEvent = event => event;

module.exports.handler = async (event, _context) => {
  const stepArn = process.env.STEP_FUNCTION_ARN;
  if (!stepArn) {
    const errorMsg = "STEP_FUNCTION_ARN environment variable is not set";
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  const stepFunc = new AWS.StepFunctions();
  const codePipeline = new AWS.CodePipeline();

  try {
    const params = {
      stateMachineArn: stepArn,
      input: JSON.stringify(transformCodePipelineEvent(event))
    };
    const data = await stepFunc.startExecution(params).promise();
    console.info(
      `started execution arn: ${data.executionArn} at ${data.startDate}`
    );

    const jobId = event["CodePipeline.job"].id;
    await codePipeline.putJobSuccessResult({ jobId }).promise();
    console.info("Marked lambda step in pipeline as completed");
  } catch (ex) {
    console.error("Error launching step function", ex);
    throw ex;
  }
};
