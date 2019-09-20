const AWS = require("aws-sdk");
// const util = require("util");

class NoTokenError extends Error {
  constructor() {
    const message = "No token for action yet";
    super(message);
    this.name = "NoTokenError";
    this.message = message;
  }
}

const getApprovalInfo = async (pipelineName, stageName, actionName) => {
  const codePipeline = new AWS.CodePipeline();
  console.info(`Checking pipeline state for pipeline: ${pipelineName}`);
  const approvalInfo = await codePipeline
    .getPipelineState({ name: pipelineName })
    .promise();

  if (!approvalInfo || !approvalInfo.stageStates) {
    console.error("Could not find stages info in request");
    console.info(JSON.stringify(approvalInfo));
    // console.info(util.inspect(approvalInfo));
    return null;
  }

  const targetStage = approvalInfo.stageStates.find(stage => {
    return (
      stage.stageName === stageName &&
      stage.latestExecution &&
      stage.latestExecution.status === "InProgress"
    );
  });

  if (!targetStage) {
    console.info("Did not find an stage to approve");
    console.info("approvalInfo", JSON.stringify(approvalInfo));
    return null;
  }

  const targetAction = targetStage.actionStates.find(action => {
    return (
      action.actionName === actionName &&
      action.latestExecution &&
      action.latestExecution.status === "InProgress"
    );
  });

  if (!targetAction) {
    console.info("Did not find an action to approve");
    console.info("targetStage", JSON.stringify(targetStage));
    return null;
  }

  if (!targetAction.latestExecution.token) {
    console.info(
      "Target action did not have a token:",
      JSON.stringify(targetAction)
    );
    return null;
  }

  return targetAction.latestExecution.token;
};

const approve = async (pipelineName, stageName, actionName, token) => {
  const codePipeline = new AWS.CodePipeline();
  const params = {
    pipelineName,
    stageName,
    actionName,
    token,
    result: {
      status: "Approved",
      summary: "Manual approval not required - no IAM changes detected"
    }
  };
  console.info("auto-approving manual approval step:", JSON.stringify(params));
  await codePipeline.putApprovalResult(params).promise();
};

module.exports.handler = async (event, _context) => {
  const jobId = event["CodePipeline.job"].id;

  const pipelineName = "image-test"; //todo
  const stageName = "iam"; //todo
  const actionName = "IAM_Approval"; //todo

  const approvalToken = await getApprovalInfo(
    pipelineName,
    stageName,
    actionName
  );
  console.info("Approval token: ", approvalToken);

  if (!approvalToken) {
    console.info("Unable to find pipeline status");
    throw new NoTokenError();
  }

  await approve(pipelineName, stageName, actionName, approvalToken);

  return event;
};
