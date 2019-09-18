#!/usr/bin/env node

const cdk = require('@aws-cdk/core');
const { PipelineConditionalApprovalStack } = require('../lib/pipeline-conditional-approval-stack');

const app = new cdk.App();
new PipelineConditionalApprovalStack(app, 'PipelineConditionalApprovalStack');
