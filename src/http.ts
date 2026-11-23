import { S } from './strings.ts';

const MAX_BODY_BYTES = 10_000;

// An error with an HTTP status. Its message is shown to the user as is, so it must be Burmese.
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function readJson(req: Request): Promise<unknown> {
  if (Number(req.headers.get('content-length')) > MAX_BODY_BYTES) throw new HttpError(413, S.web.error);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, S.web.error);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, S.web.error);
  }
}
