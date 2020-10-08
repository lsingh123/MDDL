import {
  Construct,
  CustomResource,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from '@aws-cdk/core'
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs'
import path = require('path')
import {
  Function,
  LayerVersion,
  IFunction,
  ILayerVersion,
  Runtime,
  Code,
} from '@aws-cdk/aws-lambda'
import { S3EventSource } from '@aws-cdk/aws-lambda-event-sources'
import { Bucket, IBucket, HttpMethods, EventType } from '@aws-cdk/aws-s3'
import {
  OriginAccessIdentity,
  CloudFrontWebDistribution,
} from '@aws-cdk/aws-cloudfront'
import { DataStoreStack } from './data-store-stack'
import { AuthStack } from './auth-stack'
import { Provider } from '@aws-cdk/custom-resources'
import { RetentionDays } from '@aws-cdk/aws-logs'
import { ISecret, Secret } from '@aws-cdk/aws-secretsmanager'
import {
  AnyPrincipal,
  Policy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from '@aws-cdk/aws-iam'
import { IKey, Key } from '@aws-cdk/aws-kms'
import { Certificate } from '@aws-cdk/aws-certificatemanager'
import {
  DefaultDomainMappingOptions,
  DomainName,
  HttpApi,
  HttpMethod,
  CfnRoute,
  CfnAuthorizer,
  CfnIntegration,
} from '@aws-cdk/aws-apigatewayv2'
import { ViewerCertificate } from '@aws-cdk/aws-cloudfront/lib/web_distribution'
import {
  ARecord,
  HostedZone,
  IHostedZone,
  RecordTarget,
  HostedZoneAttributes,
} from '@aws-cdk/aws-route53'
import { CloudFrontTarget } from '@aws-cdk/aws-route53-targets'
import {
  CfnUserPoolResourceServer,
  OAuthScope,
  UserPool,
} from '@aws-cdk/aws-cognito'
import { HostedDomain } from './hosted-domain'
import { ISecurityGroup, IVpc } from '@aws-cdk/aws-ec2'
import { MinimalCloudFrontTarget } from './minimal-cloudfront-target'

interface ApiHostedDomain extends HostedDomain {
  /**
   * Whether to allow any host for the CORS policy.
   * Useful for development environments.
   * @default false
   */
  corsAllowAnyHost?: boolean
}

interface JwtConfiguration {
  /**
   * The audience (aud) of the JWT token
   */
  audience: string[]

  /**
   * The issuer (iss) of the JWT token
   */
  issuer: string
}

export interface Props extends StackProps {
  /**
   * The auth stack to secure access to the application resources in this stack
   */
  authStack?: AuthStack
  /**
   * The JWT Authorizer settings if not using the auth stack
   */
  jwtAuth?: JwtConfiguration
  /**
   * Whether or not an auth stack should be provided for this
   */
  expectsAuthStack: boolean
  /**
   * The data stack that contains resources and access to the database
   */
  dataStoreStack?: DataStoreStack
  /**
   * Key-value build parameters for the web app
   */
  webAppBuildVariables?: { [index: string]: string }
  /**
   * API domain configuration
   */
  apiDomainConfig?: ApiHostedDomain
  /**
   * Web App domain configuration
   */
  webAppDomainConfig?: HostedDomain
  /**
   * Hosted zone attributes for adding record sets to
   */
  hostedZoneAttributes?: HostedZoneAttributes
}

interface ApiProps {
  api: HttpApi
  dbSecret: ISecret
  mySqlLayer: ILayerVersion
  authorizer: CfnAuthorizer
}

const pathToOtherPackageLambda = (
  packageName: string,
  handlerName = 'index.ts',
): string => path.join(__dirname, '..', '..', packageName, 'src', handlerName)

const pathToApiServiceLambda = (name: string) =>
  pathToOtherPackageLambda(`api-service`, `lambdas/${name}.ts`)

export class CityStack extends Stack {
  private static documentsBucketUploadsPrefix = 'documents/'
  private lambdaVpc: IVpc
  private lambdaSecurityGroups: ISecurityGroup[]
  private rdsEndpoint: string
  public bucketNames: { [index: string]: string }
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props)

    // initialise properties
    this.bucketNames = {}

    // read out config
    const {
      dataStoreStack,
      authStack,
      expectsAuthStack,
      apiDomainConfig,
      webAppDomainConfig,
      hostedZoneAttributes,
      jwtAuth,
    } = props

    // check auth stack is given if this stack expects it
    if (expectsAuthStack && !authStack) {
      throw new Error(
        'authStack must be provided when expectsAuthStack is true',
      )
    }

    // check auth stack is not given if this stack doesn't expect it
    if (!expectsAuthStack && authStack) {
      throw new Error(
        'authStack should not be provided when expectsAuthStack is false',
      )
    }
    // check jwt auth is given if auth stack is not
    if (!expectsAuthStack && !jwtAuth) {
      throw new Error('jwtAuth must be provided when expectsAuthStack is false')
    }

    // check data store stack is given - it is "optional" to allow for configuration
    // to be put together at runtime
    if (!dataStoreStack) {
      throw new Error('dataStoreStack must be provided')
    }

    // set VPC details for lambda access
    const { vpc, rdsAccessSecurityGroup, rdsEndpoint } = dataStoreStack
    this.lambdaVpc = vpc
    this.lambdaSecurityGroups = [rdsAccessSecurityGroup]
    this.rdsEndpoint = rdsEndpoint

    // check the cloudfront certificate is in north virginia
    if (
      webAppDomainConfig &&
      webAppDomainConfig.certificateArn &&
      !webAppDomainConfig.certificateArn.toLowerCase().includes('us-east-1')
    ) {
      throw new Error(
        'webAppDomainConfig.certificateArn must be a certificate in us-east-1',
      )
    }

    // reference hosted zone
    const hostedZone: IHostedZone | undefined = hostedZoneAttributes
      ? HostedZone.fromHostedZoneAttributes(
          this,
          `HostedZone`,
          hostedZoneAttributes,
        )
      : undefined

    // add hosting for the web app
    const { domain: webAppDomain } = this.addHosting(
      'WebApp',
      webAppDomainConfig,
      hostedZone,
    )

    // add auth stack integration
    const { jwtConfiguration } = this.addAuthIntegration(
      webAppDomain,
      authStack,
      apiDomainConfig,
      jwtAuth,
    )

    // create the city key used for encryption of resources in this stack
    const { kmsKey } = this.addKmsKey()

    // create the DB and access credentials for this city
    const { secret } = this.addDbAndCredentials(
      kmsKey,
      dataStoreStack.createDbUserFunction,
    )

    // create the mysql lambda layer
    const { layer: mySqlLayer } = this.addMysqlLayer()

    // add api
    const { api, authorizer, corsOrigins } = this.addApi(
      webAppDomain,
      jwtConfiguration,
      apiDomainConfig,
      hostedZone,
    )
    const apiProps: ApiProps = {
      api,
      authorizer,
      dbSecret: secret,
      mySqlLayer,
    }

    // create uploads bucket
    const { bucket } = this.createUploadsBucket(kmsKey, corsOrigins)

    // add user routes
    this.addUserRoutes(apiProps, bucket)

    // add document routes
    this.addDocumentRoutes(apiProps, bucket)

    // run database migrations
    this.runMigrations(secret, mySqlLayer)
  }

  /**
   * Create the bucket for storing uploads
   * @param kmsKey The encryption key for the bucket
   * @param corsOrigins CORS origins for the bucket policy
   */
  private createUploadsBucket(kmsKey: Key, corsOrigins: string[]) {
    return {
      bucket: new Bucket(this, 'DocumentsBucket', {
        blockPublicAccess: {
          blockPublicAcls: true,
          blockPublicPolicy: true,
          ignorePublicAcls: true,
          restrictPublicBuckets: true,
        },
        encryptionKey: kmsKey,
        removalPolicy: RemovalPolicy.RETAIN,
        cors: [
          {
            allowedMethods: [HttpMethods.PUT],
            allowedOrigins: corsOrigins,
            maxAge: 3000,
            allowedHeaders: [
              'x-amz-*',
              'content-type',
              'content-disposition',
              'content-length',
            ],
          },
        ],
      }),
    }
  }

  /**
   * Add any required auth integration for the stack
   * @param redirectUrl The allowed URL for redirection for the auth integration
   * @param authStack The auth stack, if any
   * @param apiDomainConfig The API's domain configuration
   * @param jwtAuth The JWT Auth, if not using the auth stack
   */
  private addAuthIntegration(
    redirectUrl: string,
    authStack?: AuthStack,
    apiDomainConfig?: HostedDomain,
    jwtAuth?: JwtConfiguration,
  ) {
    // if JWT Auth is given, shortcut out
    if (jwtAuth) {
      return { jwtConfiguration: jwtAuth }
    }

    // make sure auth stack is given - it should be as this has been checked already
    if (!authStack) {
      throw new Error('AuthStack should not be null at this point')
    }

    // add cognito specific integration
    const userPool = UserPool.fromUserPoolId(
      this,
      'UserPool',
      authStack.userPoolId,
    )
    const client = userPool.addClient('DataLockerClient', {
      authFlows: {
        userSrp: true,
      },
      preventUserExistenceErrors: true,
      oAuth: {
        callbackUrls: ['https://' + redirectUrl],
        scopes: [OAuthScope.PROFILE, OAuthScope.OPENID, OAuthScope.EMAIL],
        flows: {
          authorizationCodeGrant: true,
        },
      },
    })

    // add the resource server
    if (apiDomainConfig) {
      new CfnUserPoolResourceServer(this, 'UserPoolResourceServer', {
        identifier: 'https://' + apiDomainConfig.domain,
        name: this.stackName,
        userPoolId: authStack.userPoolId,
      })
    }

    return {
      jwtConfiguration: {
        audience: [client.userPoolClientId],
        issuer: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      },
    }
  }

  /**
   * Add hosting for a web app
   * @param appName The name of the web app
   * @param hostedDomainConfig The configuration for its hosting domain (optional)
   * @param hostedZone The hosted zone (optional)
   */
  private addHosting(
    appName: string,
    hostedDomainConfig?: HostedDomain,
    hostedZone?: IHostedZone,
  ) {
    //Create Certificate
    let viewerCertificate: ViewerCertificate | undefined
    if (hostedDomainConfig) {
      const certificate = Certificate.fromCertificateArn(
        this,
        `${appName}Certificate`,
        hostedDomainConfig.certificateArn,
      )
      viewerCertificate = ViewerCertificate.fromAcmCertificate(certificate, {
        aliases: [hostedDomainConfig.domain],
      })
    }

    // Random part included for easier update if needed
    const bucketName = `${this.stackName}-${appName}-AEBE24AF`.toLowerCase()
    this.bucketNames[appName] = bucketName

    // Create App Bucket
    const bucket = new Bucket(this, `${appName}Bucket`, {
      blockPublicAccess: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      bucketName,
    })

    // Create App Origin Access Identity
    const originAccessIdentity = new OriginAccessIdentity(
      this,
      `${appName}OriginAccessIdentity`,
      {
        comment: appName,
      },
    )
    bucket.grantRead(originAccessIdentity)

    // Create App CloudFront Distribution
    const cloudFrontDistribution = new CloudFrontWebDistribution(
      this,
      `${appName}CloudFrontWebDistribution`,
      {
        defaultRootObject: 'index.html',
        errorConfigurations: [
          {
            errorCode: 403,
            responseCode: 200,
            responsePagePath: '/index.html',
          },
          {
            errorCode: 404,
            responseCode: 200,
            responsePagePath: '/index.html',
          },
        ],
        originConfigs: [
          {
            s3OriginSource: {
              s3BucketSource: bucket,
              originAccessIdentity: originAccessIdentity,
            },
            behaviors: [
              {
                maxTtl: Duration.minutes(5),
                minTtl: Duration.minutes(5),
                defaultTtl: Duration.minutes(5),
                pathPattern: '/index.html',
                compress: true,
              },
              {
                isDefaultBehavior: true,
                compress: true,
              },
            ],
          },
        ],
        viewerCertificate,
      },
    )
    cloudFrontDistribution.node.addDependency(bucket, originAccessIdentity)

    // Create Domain Record
    if (hostedDomainConfig && hostedZone) {
      const { domain } = hostedDomainConfig
      const aliasRecord = new ARecord(this, `${appName}AliasRecord`, {
        zone: hostedZone,
        recordName: domain,
        target: RecordTarget.fromAlias(
          new CloudFrontTarget(cloudFrontDistribution),
        ),
      })
      aliasRecord.node.addDependency(cloudFrontDistribution)
    }

    return {
      domain: hostedDomainConfig
        ? hostedDomainConfig.domain
        : cloudFrontDistribution.distributionDomainName,
    }
  }

  /**
   * Add the KMS key for encrypting data for the City stack
   */
  private addKmsKey() {
    const kmsKey = new Key(this, 'Key', {
      description: `KMS Key for ${this.stackName} stack`,
      enableKeyRotation: true,
    })

    // permissions are automatically added to the key policy
    // but there seems to be issues using the key through secrets manager
    // the below resolves this by following the direction at https://docs.aws.amazon.com/kms/latest/developerguide/services-secrets-manager.html#asm-policies
    kmsKey.addToResourcePolicy(
      new PolicyStatement({
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:CreateGrant',
          'kms:DescribeKey',
        ],
        resources: ['*'],
        principals: [new AnyPrincipal()],
        conditions: {
          StringEquals: {
            'kms:ViaService': `secretsmanager.${this.region}.amazonaws.com`,
            'kms:CallerAccount': this.account,
          },
        },
      }),
    )

    return {
      kmsKey,
    }
  }

  /**
   * Create credentials, a new DB and DB User in the DB Server for the city to use
   * @param kmsKey The KMS Key to encrypt the secrets
   * @param exportedCreateDbUserFunction The function exported from the data stack to use to create the DB User
   */
  private addDbAndCredentials(
    kmsKey: IKey,
    exportedCreateDbUserFunction: IFunction,
  ) {
    // import the function
    const createDbUserFunction = Function.fromFunctionArn(
      this,
      'CreateDbUserFunction',
      exportedCreateDbUserFunction.functionArn,
    )

    // check the exported role is accessible
    if (!exportedCreateDbUserFunction.role) {
      throw new Error(
        'dataStoreStack.createDbUserFunction.role should be accessible',
      )
    }

    // import the role
    const createDbUserFunctionRole = Role.fromRoleArn(
      this,
      'CreateDbUserFunctionRole',
      exportedCreateDbUserFunction.role.roleArn,
    )

    // create a custom resource provider
    const createDbUserCustomResourceProvider = new Provider(
      this,
      'CreateDbUserCustomResourceProvider',
      {
        onEventHandler: createDbUserFunction,
        logRetention: RetentionDays.ONE_DAY,
      },
    )

    // create the new DB user's credentials
    const dbCredentials = new Secret(this, 'DbCredentialsSecret', {
      secretName: `${this.stackName}-rds-db-credentials`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: this.stackName.toLowerCase().replace(/[\W_]+/g, ''),
        }),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: 'password',
        excludeCharacters: '"@/\\',
        passwordLength: 30,
      },
      encryptionKey: kmsKey,
    })

    // allow the base function to access our new secret
    const secretAccessPolicy = new Policy(this, 'AllowAccessToDatabaseSecret', {
      roles: [createDbUserFunctionRole],
      statements: [
        new PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [dbCredentials.secretArn],
        }),
      ],
    })

    // execute the custom resource to connect to the DB Server and create the new DB and User
    const createDbUser = new CustomResource(
      this,
      'CreateDbUserCustomResource',
      {
        serviceToken: createDbUserCustomResourceProvider.serviceToken,
        properties: {
          NewUserSecretId: dbCredentials.secretArn,
        },
      },
    )
    createDbUser.node.addDependency(secretAccessPolicy)

    return { secret: dbCredentials }
  }

  /**
   * Adds and configures the API Gateway resource for this City
   * @param webAppDomain Domain for the web app, to allow CORS access from
   * @param jwtConfiguration JWT configuration for the authorizer
   * @param apiDomainConfig API Domain details (optional) for setting up the custom domain
   * @param hostedZone Hosted zone config (optional) for hooking up the custom domain
   */
  private addApi(
    webAppDomain: string,
    jwtConfiguration: JwtConfiguration,
    apiDomainConfig?: ApiHostedDomain,
    hostedZone?: IHostedZone,
  ) {
    // read out config
    const { corsAllowAnyHost = false, domain, certificateArn } =
      apiDomainConfig || {}
    apiDomainConfig || {}

    // register custom domain name if we can
    let defaultDomainMapping: DefaultDomainMappingOptions | undefined
    if (domain && certificateArn) {
      const certificate = Certificate.fromCertificateArn(
        this,
        'ApiDomainCertificate',
        certificateArn,
      )
      const domainMapping = new DomainName(this, 'ApiDomainName', {
        domainName: domain,
        certificate: certificate,
      })
      defaultDomainMapping = {
        domainName: domainMapping,
      }
      if (hostedZone) {
        new ARecord(this, `ApiAliasRecord`, {
          zone: hostedZone,
          recordName: domain,
          target: RecordTarget.fromAlias(
            new MinimalCloudFrontTarget(
              this,
              domainMapping.regionalDomainName,
              domainMapping.regionalHostedZoneId,
            ),
          ),
        })
      }
    }

    // create api
    const corsOrigins = [corsAllowAnyHost ? '*' : `https://${webAppDomain}`]
    const api = new HttpApi(this, 'Api', {
      apiName: `${this.stackName}Api`,
      corsPreflight: {
        allowMethods: [
          HttpMethod.GET,
          HttpMethod.DELETE,
          HttpMethod.OPTIONS,
          HttpMethod.POST,
        ],
        allowOrigins: corsOrigins,
      },
      defaultDomainMapping,
    })

    // create authorizer
    const authorizer = new CfnAuthorizer(this, 'ApiJwtAuthorizer', {
      apiId: api.httpApiId,
      authorizerType: 'JWT',
      jwtConfiguration: jwtConfiguration,
      identitySource: ['$request.header.Authorization'],
      name: 'JwtAuthorizer',
    })

    return {
      api,
      authorizer,
      corsOrigins,
    }
  }

  /**
   * Adds Policy Statements to allow some actions in the S3 bucket
   * @param lambdaFunction The function to apply the statements to
   * @param uploadsBucket The Documents Upload Bucket
   * @param actions The actions to allow
   */
  private addPermissionsToDocumentBucket(
    lambdaFunction: IFunction,
    uploadsBucket: IBucket,
    actions: string[],
  ) {
    lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions,
        resources: [
          uploadsBucket.arnForObjects(
            `${CityStack.documentsBucketUploadsPrefix}*`,
          ),
        ],
      }),
    )
    if (uploadsBucket.encryptionKey) {
      lambdaFunction.addToRolePolicy(
        new PolicyStatement({
          actions: ['kms:GenerateDataKey'],
          resources: [uploadsBucket.encryptionKey.keyArn],
        }),
      )
    }
  }

  /**
   * Adds user specific routes to the API
   * @param apiProps Common properties for API functions
   * @param uploadsBucket The bucket with document uploads
   */
  private addUserRoutes(apiProps: ApiProps, uploadsBucket: IBucket) {
    const { api, dbSecret, mySqlLayer, authorizer } = apiProps

    // add route and lambda to list users documents
    this.addRoute(api, {
      name: 'GetUserDocuments',
      routeKey: 'GET /users/{userId}/documents',
      lambdaFunction: this.createLambda(
        'GetUserDocuments',
        pathToApiServiceLambda('documents/getByUserId'),
        {
          dbSecret,
          layers: [mySqlLayer],
        },
      ),
      authorizer,
    })

    // create lambda to submit a document
    const postUserDocumentsLambda = this.createLambda(
      'PostUserDocuments',
      pathToApiServiceLambda('documents/createDocumentForUser'),
      {
        dbSecret,
        layers: [mySqlLayer],
        extraEnvironmentVariables: {
          DOCUMENTS_BUCKET: uploadsBucket.bucketName,
        },
      },
    )
    // permission needed to create presigned url
    this.addPermissionsToDocumentBucket(
      postUserDocumentsLambda,
      uploadsBucket,
      ['s3:PutObject'],
    )

    // add route
    this.addRoute(api, {
      name: 'PostUserDocuments',
      routeKey: 'POST /users/{userId}/documents',
      lambdaFunction: postUserDocumentsLambda,
      authorizer,
    })
  }

  /**
   * Adds document specific routes to the API
   * @param apiProps Common properties for API functions
   * @param uploadsBucket The bucket with document uploads
   */
  private addDocumentRoutes(apiProps: ApiProps, uploadsBucket: Bucket) {
    const { api, dbSecret, mySqlLayer, authorizer } = apiProps

    // create lambda to fetch a document
    const getDocumentByIdLambda = this.createLambda(
      'GetDocumentById',
      pathToApiServiceLambda('documents/getById'),
      {
        dbSecret,
        layers: [mySqlLayer],
        extraEnvironmentVariables: {
          DOCUMENTS_BUCKET: uploadsBucket.bucketName,
        },
      },
    )

    // permission needed to create presigned urls (for get and put)
    this.addPermissionsToDocumentBucket(getDocumentByIdLambda, uploadsBucket, [
      's3:PutObject',
      's3:GetObject',
    ])

    // add route
    this.addRoute(api, {
      name: 'GetDocumentById',
      routeKey: 'GET /documents/{documentId}',
      lambdaFunction: getDocumentByIdLambda,
      authorizer,
    })

    // create lambda to mark document as received
    const markFileAsReceived = this.createLambda(
      'MarkFileAsReceived',
      pathToApiServiceLambda('documents/markFileReceived'),
      {
        dbSecret,
        layers: [mySqlLayer],
      },
    )
    markFileAsReceived.addEventSource(
      new S3EventSource(uploadsBucket, {
        events: [EventType.OBJECT_CREATED],
        filters: [
          {
            prefix: CityStack.documentsBucketUploadsPrefix,
          },
        ],
      }),
    )
  }

  /**
   * Adds a route to the API
   * @param api The API to register the route with
   * @param props The props for the route
   */
  private addRoute(
    api: HttpApi,
    props: {
      name: string
      routeKey: string
      lambdaFunction: IFunction
      authorizer?: CfnAuthorizer
    },
  ) {
    const { name, routeKey, lambdaFunction, authorizer } = props
    const grant = lambdaFunction.grantInvoke(
      new ServicePrincipal('apigateway.amazonaws.com'),
    )
    if (grant.principalStatement) {
      grant.principalStatement.addCondition('ArnLike', {
        'AWS:SourceArn': `arn:${this.partition}:execute-api:${this.region}:${this.account}:${api.httpApiId}/*/*`,
      })
    }

    const integration = new CfnIntegration(this, `${name}Integration`, {
      apiId: api.httpApiId,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/functions/${lambdaFunction.functionArn}/invocations`,
      payloadFormatVersion: '2.0',
    })
    grant.applyBefore(integration)

    new CfnRoute(this, `${name}Route`, {
      apiId: api.httpApiId,
      routeKey: routeKey,
      target: `integrations/${integration.ref}`,
      authorizerId: authorizer ? authorizer.ref : undefined,
      authorizationType: authorizer ? authorizer.authorizerType : undefined,
    })
  }

  /**
   * Create a lambda function with a standard configuration
   * @param name The name for constructs
   * @param path The path to the entrypoint
   * @param props Extra properties for the function
   */
  private createLambda(
    name: string,
    path: string,
    props: {
      handler?: string
      dbSecret?: ISecret
      extraEnvironmentVariables?: { [key: string]: string }
      layers?: ILayerVersion[]
    },
  ) {
    const {
      handler = 'handler',
      dbSecret,
      extraEnvironmentVariables = {},
      layers,
    } = props
    const requiresDbConnectivity = !!dbSecret
    const dbParams: { [key: string]: string } = dbSecret
      ? {
          DB_HOST: this.rdsEndpoint,
          DB_USER: dbSecret.secretValueFromJson('username').toString(),
          DB_PASSWORD: dbSecret.secretValueFromJson('password').toString(),
          DB_NAME: dbSecret.secretValueFromJson('username').toString(),
        }
      : {}
    return new NodejsFunction(this, name, {
      entry: path,
      handler,
      environment: {
        NODE_ENV: 'production',
        ...dbParams,
        ...extraEnvironmentVariables,
      },
      layers,
      externalModules: requiresDbConnectivity
        ? ['aws-sdk', 'knex', 'mysql2', 'objection']
        : undefined,
      runtime: Runtime.NODEJS_12_X,
      minify: true,
      vpc: requiresDbConnectivity ? this.lambdaVpc : undefined,
      securityGroups: requiresDbConnectivity
        ? this.lambdaSecurityGroups
        : undefined,
    })
  }

  /**
   * Adds the mysql lambda layer to the stack
   */
  private addMysqlLayer() {
    return {
      layer: new LayerVersion(this, 'MysqlLayer', {
        code: Code.fromAsset(
          path.join(__dirname, 'lambdas', 'sql-layer', 'layer.zip'),
        ),
        compatibleRuntimes: [Runtime.NODEJS_12_X],
      }),
    }
  }

  /**
   * Runs DB migrations using Knex
   * @param dbSecret The DB secret for accessing the database
   * @param mysqlLayer The mysql layer
   */
  private runMigrations(dbSecret: ISecret, mysqlLayer: ILayerVersion) {
    const runMigrationsFunction = new Function(this, 'RunMigrationsFunction', {
      code: Code.fromAsset(
        path.join(__dirname, '..', '..', 'api-service', 'dist', 'migrator'),
      ),
      handler: 'index.handler',
      runtime: Runtime.NODEJS_12_X,
      vpc: this.lambdaVpc,
      securityGroups: this.lambdaSecurityGroups,
      layers: [mysqlLayer],
      timeout: Duration.seconds(60),
      environment: {
        DB_HOST: this.rdsEndpoint,
        DB_USER: dbSecret.secretValueFromJson('username').toString(),
        DB_PASSWORD: dbSecret.secretValueFromJson('password').toString(),
        DB_NAME: dbSecret.secretValueFromJson('username').toString(),
      },
    })

    // create a custom resource provider
    const runMigrationsResourceProvider = new Provider(
      this,
      'RunMigrationsCustomResourceProvider',
      {
        onEventHandler: runMigrationsFunction,
        logRetention: RetentionDays.ONE_DAY,
      },
    )

    new CustomResource(this, 'RunMigrationsCustomResource', {
      serviceToken: runMigrationsResourceProvider.serviceToken,
      properties: {
        // Dynamic prop to force execution each time
        Execution: Math.random().toString(36).substr(2),
      },
    })
  }
}
