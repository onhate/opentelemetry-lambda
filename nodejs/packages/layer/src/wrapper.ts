import { NodeTracerConfig, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SDKRegistrationConfig,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { Instrumentation, registerInstrumentations } from '@opentelemetry/instrumentation';
import { awsLambdaDetector } from '@opentelemetry/resource-detector-aws';
import {
  detectResourcesSync,
  envDetector,
  processDetector,
} from '@opentelemetry/resources';
import { AwsInstrumentation, AwsSdkInstrumentationConfig } from '@opentelemetry/instrumentation-aws-sdk';
import { AwsLambdaInstrumentation } from '@opentelemetry/instrumentation-aws-lambda';
import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
} from "@opentelemetry/api";
import { getEnv } from '@opentelemetry/core';
import { AwsLambdaInstrumentationConfig } from '@opentelemetry/instrumentation-aws-lambda';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { MeterProvider, MeterProviderOptions } from '@opentelemetry/sdk-metrics';

function defaultConfigureInstrumentations() {
  // Use require statements for instrumentation to avoid having to have transitive dependencies on all the typescript
  // definitions.
  const { DnsInstrumentation } = require('@opentelemetry/instrumentation-dns');
  const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
  const { GraphQLInstrumentation } = require('@opentelemetry/instrumentation-graphql');
  const { GrpcInstrumentation } = require('@opentelemetry/instrumentation-grpc');
  const { HapiInstrumentation } = require('@opentelemetry/instrumentation-hapi');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { IORedisInstrumentation } = require('@opentelemetry/instrumentation-ioredis');
  const { KoaInstrumentation } = require('@opentelemetry/instrumentation-koa');
  const { MongoDBInstrumentation } = require('@opentelemetry/instrumentation-mongodb');
  const { MySQLInstrumentation } = require('@opentelemetry/instrumentation-mysql');
  const { NetInstrumentation } = require('@opentelemetry/instrumentation-net');
  const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
  const { RedisInstrumentation } = require('@opentelemetry/instrumentation-redis');
  return [  new DnsInstrumentation(),
    new ExpressInstrumentation(),
    new GraphQLInstrumentation(),
    new GrpcInstrumentation(),
    new HapiInstrumentation(),
    new HttpInstrumentation(),
    new IORedisInstrumentation(),
    new KoaInstrumentation(),
    new MongoDBInstrumentation(),
    new MySQLInstrumentation(),
    new NetInstrumentation(),
    new PgInstrumentation(),
    new RedisInstrumentation(),
  ]
}

declare global {
  // in case of downstream configuring span processors etc
  function configureTracerProvider(tracerProvider: NodeTracerProvider): void
  function configureTracer(defaultConfig: NodeTracerConfig): NodeTracerConfig;
  function configureSdkRegistration(
    defaultSdkRegistration: SDKRegistrationConfig
  ): SDKRegistrationConfig;
  function configureMeter(defaultConfig: MeterProviderOptions): MeterProviderOptions;
  function configureMeterProvider(meterProvider: MeterProvider): void
  function configureAwsInstrumentation(config: AwsSdkInstrumentationConfig): AwsSdkInstrumentationConfig
  function configureLambdaInstrumentation(config: AwsLambdaInstrumentationConfig): AwsLambdaInstrumentationConfig
  function configureInstrumentations(): Instrumentation[]
}

console.log('Registering OpenTelemetry');

function getConfigOrFallback<T>(provider: (p:T) => T, fallback: T): T {
  return typeof provider === 'function' ? provider(fallback) : fallback;
}

const instrumentations = [
  new AwsInstrumentation(getConfigOrFallback(global.configureAwsInstrumentation, { suppressInternalInstrumentation: true })),
  new AwsLambdaInstrumentation(getConfigOrFallback(global.configureLambdaInstrumentation, {})),
  ...(getConfigOrFallback(global.configureInstrumentations, undefined) ?? defaultConfigureInstrumentations())
];

// configure lambda logging
const logLevel = getEnv().OTEL_LOG_LEVEL
diag.setLogger(new DiagConsoleLogger(), logLevel)

// Register instrumentations synchronously to ensure code is patched even before provider is ready.
registerInstrumentations({
  instrumentations,
});

async function initializeProvider() {
  const resource = detectResourcesSync({
    detectors: [awsLambdaDetector, envDetector, processDetector],
  });

  const config: NodeTracerConfig = getConfigOrFallback(global.configureTracer, { resource })

  const tracerProvider = new NodeTracerProvider(config);
  if (typeof configureTracerProvider === 'function') {
    configureTracerProvider(tracerProvider)
  } else {
    // defaults
    tracerProvider.addSpanProcessor(
      new BatchSpanProcessor(new OTLPTraceExporter())
    );
  }
  // logging for debug
  if (logLevel === DiagLogLevel.DEBUG) {
    tracerProvider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }

  const sdkRegistrationConfig: SDKRegistrationConfig = getConfigOrFallback(global.configureSdkRegistration, {});
  tracerProvider.register(sdkRegistrationConfig);

  // Configure default meter provider (doesn't export metrics)
  const meterConfig: MeterProviderOptions = getConfigOrFallback(global.configureMeter, { resource })
  const meterProvider = new MeterProvider(meterConfig);
  if (typeof configureMeterProvider === 'function') {
    configureMeterProvider(meterProvider)
  }

  // Re-register instrumentation with initialized provider. Patched code will see the update.
  registerInstrumentations({
    instrumentations,
    tracerProvider,
    meterProvider
  });
}
initializeProvider();
