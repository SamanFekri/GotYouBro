import { ERROR_STATUS } from '../lib/errors.js';

const errorCodes = Object.keys(ERROR_STATUS);

const errorResponse = (code: string, message: string, description: string) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
      example: { success: false, error: { code, message } },
    },
  },
});

const backupExample = {
  id: 'k3j9x2m4q8w1z7p0',
  serviceId: 'a1b2c3d4e5f6g7h8',
  filename: 'database.sqlite',
  sizeBytes: 13002342,
  status: 'RECEIVED',
  error: null,
  createdAt: '2026-09-23T18:30:00.000Z',
  completedAt: null,
};

const commonErrors = {
  '401': errorResponse('INVALID_TOKEN', 'Invalid API token', 'Missing, invalid (`INVALID_TOKEN`) or revoked (`TOKEN_REVOKED`) token'),
  '403': errorResponse('SERVICE_DISABLED', 'Service is disabled', 'Owner blocked (`USER_BLOCKED`) or service disabled/suspended (`SERVICE_DISABLED`)'),
  '429': {
    ...errorResponse('RATE_LIMITED', 'Too many requests', 'Rate limit exceeded. See `Retry-After`.'),
    headers: {
      'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until the limit resets' },
      'X-RateLimit-Limit': { schema: { type: 'integer' } },
      'X-RateLimit-Remaining': { schema: { type: 'integer' } },
      'X-RateLimit-Reset': { schema: { type: 'integer' }, description: 'Unix time (seconds)' },
    },
  },
};

const uploadResponses = {
  '200': {
    description: 'Delivered (with `wait=true`) or idempotent replay of an earlier request (`Idempotent-Replayed: true`).',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/BackupEnvelope' }, example: { success: true, data: { ...backupExample, status: 'SUCCESS', completedAt: '2026-09-23T18:30:02.000Z' } } } },
  },
  '202': {
    description: 'Accepted and queued for delivery. Poll `GET /api/v1/backups/{id}` for the result.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/BackupEnvelope' }, example: { success: true, data: backupExample } } },
  },
  '400': errorResponse('INVALID_FILE', 'The uploaded file is empty', 'Missing/empty file (`INVALID_FILE`) or bad input (`VALIDATION_ERROR`)'),
  ...commonErrors,
  '413': errorResponse('FILE_TOO_LARGE', 'File exceeds the maximum allowed size of 1536 MB', 'File exceeds the size limit'),
  '415': errorResponse('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/octet-stream', 'Wrong Content-Type'),
  '422': errorResponse('DESTINATION_NOT_CONFIGURED', 'No backup destination is configured for this service', 'No destination (`DESTINATION_NOT_CONFIGURED`) or unverified destination (`DESTINATION_NOT_VERIFIED`)'),
  '502': errorResponse('TELEGRAM_DELIVERY_FAILED', 'Bad Request: chat not found', 'Only with `wait=true`: Telegram rejected the upload'),
};

const uploadParams = [
  { $ref: '#/components/parameters/IdempotencyKey' },
  { name: 'wait', in: 'query', schema: { type: 'boolean', default: false }, description: 'Wait for Telegram delivery (up to BACKUP_WAIT_TIMEOUT_SECONDS) before responding.' },
  { name: 'filename', in: 'query', schema: { type: 'string', maxLength: 255 }, description: 'Override the filename shown in Telegram.' },
];

export function buildOpenApiDocument(serverUrl?: string) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'GotYouBro API',
      version: '1.0.0',
      description: [
        'Send backups to Telegram and report heartbeats for health monitoring.',
        '',
        '## Authentication',
        'Every request uses the service API token created in the Web App:',
        '',
        '```',
        'Authorization: Bearer gyb_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        '```',
        '',
        'Tokens identify a single service. They are shown only once; rotate or revoke them in the Web App.',
        '',
        '## Response format',
        'Success: `{ "success": true, "data": { ... } }`  ',
        'Error: `{ "success": false, "error": { "code": "RATE_LIMITED", "message": "Too many requests" } }`',
        '',
        '## Rate limits',
        '| Scope | Default | Applies to |',
        '|---|---|---|',
        '| Per IP | 300/minute | every `/api` request |',
        '| Per user (all services combined) | 60/minute | backups, status and info endpoints |',
        '| Per user (all services combined) | 30/hour | backup uploads |',
        '| Per service | 10/minute | heartbeats |',
        '',
        'Limits are aggregated per user so creating more services does not increase quota. Admins can',
        'change defaults and set per-user / per-service overrides. Rate limited responses return `429`',
        'with `Retry-After` and `X-RateLimit-*` headers.',
        '',
        '## Error codes',
        errorCodes.map((c) => `\`${c}\``).join(', '),
      ].join('\n'),
    },
    servers: serverUrl ? [{ url: serverUrl }] : [],
    tags: [
      { name: 'Backups', description: 'Upload files to the service\'s Telegram destination' },
      { name: 'Health', description: 'Heartbeat-based health monitoring' },
      { name: 'Service', description: 'Token introspection' },
      { name: 'System', description: 'Liveness and readiness probes' },
    ],
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/v1/backups': {
        post: {
          tags: ['Backups'],
          summary: 'Upload a backup (multipart)',
          description:
            'Send the file as the `file` form field. The file is streamed to a temporary file, delivered to Telegram asynchronously and then deleted.\n\n```bash\ncurl -X POST https://example.com/api/v1/backups \\\n  -H "Authorization: Bearer $GOTYOUBRO_TOKEN" \\\n  -H "Idempotency-Key: nightly-2026-09-23" \\\n  -F "file=@backup.sqlite"\n```',
          parameters: uploadParams,
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } },
              },
            },
          },
          responses: uploadResponses,
        },
      },
      '/api/v1/backups/raw': {
        post: {
          tags: ['Backups'],
          summary: 'Upload a backup (raw body)',
          description:
            'Send the file bytes as the request body. Set the filename with the `X-Filename` header (URL-encoded) or `filename` query parameter.\n\n```bash\ncurl -X POST https://example.com/api/v1/backups/raw \\\n  -H "Authorization: Bearer $GOTYOUBRO_TOKEN" \\\n  -H "Content-Type: application/octet-stream" \\\n  -H "X-Filename: dump.sql.gz" \\\n  --data-binary @dump.sql.gz\n```',
          parameters: [...uploadParams, { name: 'X-Filename', in: 'header', schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
          responses: uploadResponses,
        },
      },
      '/api/v1/backups/{id}': {
        get: {
          tags: ['Backups'],
          summary: 'Get backup status',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Backup record',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/BackupEnvelope' },
                  example: { success: true, data: { ...backupExample, status: 'SUCCESS', completedAt: '2026-09-23T18:30:02.000Z' } },
                },
              },
            },
            '404': errorResponse('BACKUP_NOT_FOUND', 'Backup not found', 'Unknown backup (or belongs to another service)'),
            ...commonErrors,
          },
        },
      },
      '/api/v1/health/heartbeat': {
        post: {
          tags: ['Health'],
          summary: 'Send a heartbeat',
          description:
            'Updates the service\'s current health state. Heartbeats are not stored individually. If no heartbeat arrives within `interval + grace` seconds the service is marked DOWN and the owner is alerted once; the next heartbeat marks it HEALTHY and sends one recovery message.\n\n```bash\ncurl -X POST https://example.com/api/v1/health/heartbeat -H "Authorization: Bearer $GOTYOUBRO_TOKEN"\n```',
          responses: {
            '200': {
              description: 'Heartbeat recorded',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HeartbeatEnvelope' },
                  example: {
                    success: true,
                    data: {
                      serviceId: 'a1b2c3d4e5f6g7h8',
                      healthStatus: 'HEALTHY',
                      healthEnabled: true,
                      lastHeartbeatAt: '2026-09-23T18:30:00.000Z',
                      nextHeartbeatDeadline: '2026-09-23T18:32:00.000Z',
                      recovered: false,
                    },
                  },
                },
              },
            },
            ...commonErrors,
          },
        },
      },
      '/api/v1/service': {
        get: {
          tags: ['Service'],
          summary: 'Describe the service this token belongs to',
          responses: { '200': { description: 'Service info and effective limits' }, ...commonErrors },
        },
      },
      '/health': { get: { tags: ['System'], security: [], summary: 'Liveness probe', responses: { '200': { description: 'Process is alive' } } } },
      '/ready': {
        get: {
          tags: ['System'],
          security: [],
          summary: 'Readiness probe (checks SQLite)',
          responses: { '200': { description: 'Ready' }, '503': errorResponse('NOT_READY', 'Database unavailable', 'Not ready') },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'gyb_ token' } },
      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          schema: { type: 'string', maxLength: 128 },
          description: 'Retrying with the same key returns the original backup instead of uploading a duplicate; if that backup failed, the retry is uploaded again. Scoped to the service.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['success', 'error'],
          properties: {
            success: { type: 'boolean', enum: [false] },
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: { code: { type: 'string', enum: errorCodes }, message: { type: 'string' }, details: {} },
            },
          },
        },
        Backup: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            serviceId: { type: 'string' },
            filename: { type: 'string' },
            sizeBytes: { type: 'integer' },
            status: { type: 'string', enum: ['RECEIVED', 'PROCESSING', 'SUCCESS', 'FAILED'] },
            error: { type: 'object', nullable: true, properties: { code: { type: 'string' }, message: { type: 'string' } } },
            idempotent: { type: 'boolean', description: 'Present on idempotent replays' },
            createdAt: { type: 'string', format: 'date-time' },
            completedAt: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        BackupEnvelope: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Backup' } } },
        HeartbeatEnvelope: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                serviceId: { type: 'string' },
                healthStatus: { type: 'string', enum: ['UNKNOWN', 'HEALTHY', 'DOWN'] },
                healthEnabled: { type: 'boolean' },
                lastHeartbeatAt: { type: 'string', format: 'date-time' },
                nextHeartbeatDeadline: { type: 'string', format: 'date-time', nullable: true },
                recovered: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  };
}
