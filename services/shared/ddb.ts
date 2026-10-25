import { BatchWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

type WriteRequest = { PutRequest: { Item: Record<string, unknown> } } | { DeleteRequest: { Key: Record<string, unknown> } };

const MAX_ROUNDS = 8;

/** BatchWrite in chunks of 25, retrying unprocessed items with backoff. Throws if they never drain. */
export async function batchWrite(ddb: DynamoDBDocumentClient, table: string, requests: WriteRequest[]): Promise<void> {
  for (let i = 0; i < requests.length; i += 25) {
    let pending = requests.slice(i, i + 25);
    for (let round = 0; pending.length > 0; round++) {
      if (round === MAX_ROUNDS) throw new Error(`DynamoDB left ${pending.length} writes unprocessed after ${MAX_ROUNDS} rounds`);
      if (round > 0) await sleep(Math.min(2000, 50 * 2 ** round) * (0.5 + Math.random()));
      const out = await ddb.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }));
      pending = (out.UnprocessedItems?.[table] ?? []) as WriteRequest[];
    }
  }
}

export const putRequests = (items: Record<string, unknown>[]): WriteRequest[] => items.map((Item) => ({ PutRequest: { Item } }));
export const deleteRequests = (keys: Record<string, unknown>[]): WriteRequest[] => keys.map((Key) => ({ DeleteRequest: { Key } }));

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
