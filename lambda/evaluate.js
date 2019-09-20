const asyncLib = require("async");
const AWS = require("aws-sdk");
const JSZip = require("jszip");
const uuidv4 = require("uuid/v4");

const IAM_FILE_PATTERN = /Role.*\.yaml/;

const getIamFileFromZip = async (s3Location, filenamePattern) => {
  try {
    const s3 = new AWS.S3();
    const data = await s3.getObject(s3Location).promise();
    const zip = await JSZip.loadAsync(data.Body);
    const iamTemplatesFromZip = [];
    await zip.filter(async (relativePath, file) => {
      const isMatch = relativePath.match(filenamePattern);
      if (isMatch) {
        console.info("Found match: ", relativePath);
        iamTemplatesFromZip.push(file);
      }
      return isMatch;
    }); //couldn't get zip.filter to work as expected.  It seemed to always include all file when used as documented

    if (iamTemplatesFromZip.length === 0) {
      console.info(
        `No file matching the pattern: ${filenamePattern} was found.`
      );
      return null;
    } else if (iamTemplatesFromZip.length > 1) {
      console.info(
        `Multiple files matching the pattern: ${filenamePattern} were found.  Only using the first.`
      );
      console.info("files: " + iamTemplatesFromZip.map(zipObj => zipObj.name));
    }

    return iamTemplatesFromZip[0].async("string");
  } catch (ex) {
    console.error("Unable to read zip file from S3", ex);
    console.info("s3Location", JSON.stringify(s3Location));
    return null;
  }
};

const getCurrentStack = async stackName => {
  const cloudFormation = new AWS.CloudFormation();

  try {
    const data = await cloudFormation
      .describeStacks({ StackName: stackName })
      .promise();
    if (!data.Stacks.length) {
      console.info(`Did not find current stack ${stackName}`);
      return null;
    }

    return data.Stacks[0];
  } catch (ex) {
    console.error(
      `Error getting information on current stack ${stackName}`,
      ex
    );
    return null;
  }
};

const createChanageSet = async (currentStack, templateBody) => {
  const cloudFormation = new AWS.CloudFormation();

  const stackParams = currentStack.Parameters.map(param => ({
    ParameterKey: param.ParameterKey,
    UsePreviousValue: true
  }));

  const params = {
    ChangeSetName: "chg" + uuidv4(),
    StackName: currentStack.StackName,
    Capabilities: ["CAPABILITY_NAMED_IAM"],
    ChangeSetType: "UPDATE",
    Description:
      "Temporary Change Set to see if stack has changed and needs to be submitted for approval",
    Parameters: stackParams,
    TemplateBody: templateBody,
    UsePreviousTemplate: false
  };

  return await cloudFormation.createChangeSet(params).promise();
};

const changeSetHasChanges = async pendingChangeSet => {
  const cloudFormation = new AWS.CloudFormation();

  console.log("Waiting for change set creation to be complete");
  let changeSet;
  try {
    changeSet = await cloudFormation
      .waitFor("changeSetCreateComplete", {
        ChangeSetName: pendingChangeSet.Id
      })
      .promise();
    console.log(`Change set creation complete, status=${changeSet.Status}`);
  } catch (ex) {
    console.info(
      "There was an error from waitFor.  This may be ok, it is stupid when there are no changes in the change set.  Checking the change set directly",
      ex
    );
    changeSet = await cloudFormation
      .describeChangeSet({ ChangeSetName: pendingChangeSet.Id })
      .promise();
  }

  if (changeSet.Status === "FAILED") {
    if (changeSet.StatusReason.match(/didn.t contain changes/)) {
      console.info("changeSet did not have any changes");
      return false;
    }

    console.error(
      `Create change set FAILED: ${changeSet.StatusReason}.  Treating it as a change`
    );
    return true;
  }

  if (changeSet.Changes.length) {
    console.info("Changes found:");
    changeSet.Changes.forEach(change => {
      console.info(
        `${change.ResourceChange.Action} to ${change.ResourceChange.LogicalResourceId} of type ${change.ResourceChange.ResourceType}`
      );
    });
    return true;
  } else {
    console.info("No changes found");
    return false;
  }
};

const deleteChangeSet = async changeSet => {
  const cloudFormation = new AWS.CloudFormation();

  console.info("Deleting change set");

  await cloudFormation
    .deleteChangeSet({
      ChangeSetName: changeSet.Id
    })
    .promise();
};

const stackHasChanges = async (stackName, templateBody) => {
  const currentStack = await getCurrentStack(stackName);
  if (!currentStack) {
    console.info(
      `Stack ${stackName} does not exist, treating creation as a change`
    );
    return true;
  }

  const changeSet = await createChanageSet(currentStack, templateBody);

  let hasChanges;
  try {
    hasChanges = await changeSetHasChanges(changeSet);
  } catch (ex) {
    hasChanges = true;
    console.error(
      `Error evaluating change set for stack ${stackName}, treating template as a change`,
      ex
    );
  }

  await deleteChangeSet(changeSet);

  return hasChanges;
};

const hasArtifactChanged = async (stackName, inputArtifact) => {
  if (
    !inputArtifact ||
    !inputArtifact.location ||
    inputArtifact.location.type !== "S3"
  ) {
    console.warn(
      "Input artifact is not from S3, ignoring it",
      JSON.stringify(inputArtifact)
    );
    return false;
  }

  const s3Location = {
    Bucket: inputArtifact.location.s3Location.bucketName,
    Key: inputArtifact.location.s3Location.objectKey
  };
  const iamTemplateFromArtifact = await getIamFileFromZip(
    s3Location,
    IAM_FILE_PATTERN
  );

  if (!iamTemplateFromArtifact) {
    return false;
  }

  return await stackHasChanges(stackName, iamTemplateFromArtifact);
};

module.exports.handler = async (event, _context) => {
  if (!event["CodePipeline.job"]) {
    console.warn("Could not find CodePipeline.job in request");
    console.info("event:", JSON.stringify(event));
    event.autoApprove = false;
    return event;
  }

  console.log("JobId", event["CodePipeline.job"].id);

  if (
    !event["CodePipeline.job"].data ||
    !event["CodePipeline.job"].data.inputArtifacts ||
    !event["CodePipeline.job"].data.inputArtifacts.length
  ) {
    console.warn("Could not find inputArtifacts in request");
    console.info("event:", JSON.stringify(event));
    event.autoApprove = false;
    return event;
  }

  if (
    !event["CodePipeline.job"].data.actionConfiguration ||
    !event["CodePipeline.job"].data.actionConfiguration.configuration ||
    !event["CodePipeline.job"].data.actionConfiguration.configuration
      .UserParameters
  ) {
    console.warn("Could not find stack name in request");
    console.info("event:", JSON.stringify(event));
    event.autoApprove = false;
    return event;
  }

  const inputArtifacts = event["CodePipeline.job"].data.inputArtifacts;

  const stackName =
    event["CodePipeline.job"].data.actionConfiguration.configuration
      .UserParameters;

  console.info("Checking for changes to stack: ", stackName);

  //todo error 2019-09-19T21:38:31.787Z cd977b9f-2af7-442c-82d5-80495e7dafa3
  // ERROR Unable to read zip file from S3 { AccessDenied: Access Denied

  const changedArtifacts = await asyncLib.filter(
    inputArtifacts,
    async artifact => {
      return await hasArtifactChanged(stackName, artifact);
    }
  );

  if (changedArtifacts.length) {
    const bucket = changedArtifacts[0].location.bucketName;
    const key = changedArtifacts[0].location.objectKey;
    console.info(
      `Change detected in IAM template contained in s3://${bucket}/${key}`
    );
    event.autoApprove = false;
  } else {
    console.info("No changed dected in IAM template");
    event.autoApprove = true;
  }

  return event;
};
