/** HTTP API route keys. Shared by the handler's router and the CDK stack that registers them. */
export const API_ROUTE_KEYS = [
  'GET /inboxes/{address}/messages',
  'GET /feed',
  'GET /messages/{id}',
  'GET /messages/{id}/raw',
  'GET /messages/{id}/attachments/{index}',
  'DELETE /messages/{id}',
  'DELETE /inboxes/{address}/messages',
  'POST /messages/{id}/reparse',
] as const;

export type ApiRouteKey = (typeof API_ROUTE_KEYS)[number];
