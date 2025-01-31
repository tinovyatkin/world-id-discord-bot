import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { EventBus, Rule, RuleTargetInput } from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import {
  Architecture,
  FunctionUrlAuthType,
  LayerVersion,
  Runtime,
  type Function as Lambda,
} from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import {
  NodejsFunction,
  type NodejsFunctionProps,
} from "aws-cdk-lib/aws-lambda-nodejs";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { CfnApplication } from "aws-cdk-lib/aws-sam";
import type { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { Queue } from "aws-cdk-lib/aws-sqs";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

import { ON_VERIFIED_EVENT, WORLD_ID_EVENTS_SOURCE } from "./events";

export class WorldIdVerifier extends Construct {
  readonly queue: Queue;
  readonly processor: Lambda;
  readonly #dlq: Queue;

  constructor(
    scope: Construct,
    props: {
      defaultLambdaProps?: Partial<NodejsFunctionProps>;
      botToken: ISecret;
      rolesToAssignToVerifiedUsers: string[];
    },
  ) {
    super(scope, "World ID Verification Resources");

    this.#dlq = new Queue(this, "DLQ for World ID queue", {
      retentionPeriod: Duration.days(14),
      visibilityTimeout: Duration.minutes(15),
    });

    this.queue = new Queue(this, "World ID verification queue", {
      deadLetterQueue: {
        maxReceiveCount: 1,
        queue: this.#dlq,
      },
      visibilityTimeout: Duration.minutes(15),
    });

    const eventBus = new EventBus(this, "World ID EventBus");

    /** @see {@link https://github.com/charoitel/lambda-layer-canvas-nodejs} */
    const nodeCanvasLayer = new CfnApplication(this, "NodeCanvasLayer", {
      location: {
        applicationId:
          "arn:aws:serverlessrepo:us-east-1:990551184979:applications/lambda-layer-canvas-nodejs",
        semanticVersion: "2.9.1",
      },
    });
    nodeCanvasLayer.applyRemovalPolicy(RemovalPolicy.DESTROY);

    /**
     * Temporary workaround until following will be merged:
     * https://github.com/charoitel/lambda-layer-canvas-nodejs/pull/7
     */
    const lv = new AwsCustomResource(this, "Get Layer Version", {
      resourceType: "Custom::GetStackResources",
      onUpdate: {
        outputPaths: ["StackResources.0"],
        service: "CloudFormation",
        action: "describeStackResources",
        parameters: {
          StackName: nodeCanvasLayer.ref,
        },
        physicalResourceId: PhysicalResourceId.fromResponse(
          "StackResources.0.PhysicalResourceId",
        ),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
      logRetention: RetentionDays.ONE_WEEK,
    });
    lv.node.addDependency(nodeCanvasLayer);

    const nodeCanvasLayerVersion = LayerVersion.fromLayerVersionArn(
      this,
      "NodeCanvasLayerVersion",
      lv.getResponseField("StackResources.0.PhysicalResourceId"),
    );

    const qrGenerator = new NodejsFunction(this, "qr-generator", {
      description: "Generates PNG image for QR code",
      ...(props.defaultLambdaProps ?? {}),
      architecture: Architecture.X86_64,
      timeout: Duration.seconds(10),
      reservedConcurrentExecutions: 100,
      bundling: {
        ...(props.defaultLambdaProps?.bundling ?? {}),
        externalModules: [
          ...(props.defaultLambdaProps?.bundling?.externalModules ?? []),
          "canvas",
        ],
        loader: {
          ...(props.defaultLambdaProps?.bundling?.loader ?? {}),
          ".svg": "dataurl",
        },
        define: {
          self: "globalThis",
        },
        target: "node14.18",
      },
      runtime: Runtime.NODEJS_14_X, // Canvas layer only supports 14.x for now
      layers: [nodeCanvasLayerVersion],
    });

    const qrGeneratorUrl = qrGenerator.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ["*"],
        allowCredentials: true,
        maxAge: Duration.days(1),
      },
    });

    const rolesAssigningLambda = new NodejsFunction(
      this,
      "Role Assignment  Verification Success Handler",
      {
        ...(props.defaultLambdaProps ?? {}),
        description:
          "Assigns role(s) to an user on successful verification with World ID",
        timeout: Duration.seconds(20),
        entry: require.resolve("./assign-roles-on-verified.lambda.ts"),
      },
    );
    rolesAssigningLambda.addEnvironment(
      "ROLES_TO_ASSIGN",
      props.rolesToAssignToVerifiedUsers.join(","),
    );
    rolesAssigningLambda.addEnvironment(
      "TOKEN_SECRET_ARN",
      props.botToken.secretArn,
    );
    props.botToken.grantRead(rolesAssigningLambda);

    new Rule(this, "On Verification Success", {
      description:
        "Emitted when an user successfully completed verification with World ID",
      eventBus,
      eventPattern: {
        source: [WORLD_ID_EVENTS_SOURCE],
        detailType: [ON_VERIFIED_EVENT],
      },
      targets: [
        new eventsTargets.LambdaFunction(rolesAssigningLambda, {
          event: RuleTargetInput.fromEventPath("$.detail"),
        }),
      ],
    });

    this.processor = new NodejsFunction(this, "queue-processing", {
      description:
        "Function that processes SQS messages and doing World ID verification flow",
      ...(props.defaultLambdaProps ?? {}),
      timeout: Duration.minutes(15),
      reservedConcurrentExecutions: 100,
      memorySize: 256,
      environment: {
        ...(props.defaultLambdaProps?.environment ?? {}),

        TOKEN_SECRET_ARN: props.botToken.secretArn,
        QR_GENERATOR_URL: qrGeneratorUrl.url,
        EVENT_BUS_NAME: eventBus.eventBusName,

        // Worldcoin ID related settings
        APP_NAME: this.node.tryGetContext("app_name"),
        ACTION_ID: this.node.tryGetContext("action_id"),
        SIGNAL: this.node.tryGetContext("signal"),
        SIGNAL_DESCRIPTION: this.node.tryGetContext("signal_description"),
      },
    });
    this.processor.addEventSource(
      new SqsEventSource(this.queue, { batchSize: 1 }),
    );
    props.botToken.grantRead(this.processor);
    eventBus.grantPutEventsTo(this.processor);
  }
}
