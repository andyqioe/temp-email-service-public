import path from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { REPO_ROOT } from '../../config/load';

export interface FnOptions {
  /** Entry file relative to the repo root. */
  entry: string;
  memoryMb: number;
  timeoutSeconds: number;
  environment?: Record<string, string>;
  description?: string;
}

/** Every Lambda in the project: Node 24 on arm64 (Graviton, ~20% cheaper), bundled locally with esbuild. */
export function nodeFunction(scope: Construct, id: string, opts: FnOptions): NodejsFunction {
  const logGroup = new LogGroup(scope, `${id}Logs`, {
    retention: RetentionDays.TWO_WEEKS,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  return new NodejsFunction(scope, id, {
    entry: path.join(REPO_ROOT, opts.entry),
    handler: 'handler',
    runtime: Runtime.NODEJS_24_X,
    architecture: Architecture.ARM_64,
    memorySize: opts.memoryMb,
    timeout: Duration.seconds(opts.timeoutSeconds),
    description: opts.description,
    logGroup,
    projectRoot: REPO_ROOT,
    depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
    environment: { NODE_OPTIONS: '--enable-source-maps', ...opts.environment },
    bundling: {
      // Bundle the AWS SDK too, so the code runs against the exact versions it was tested with.
      externalModules: [],
      minify: true,
      sourceMap: true,
      target: 'node24',
    },
  });
}
