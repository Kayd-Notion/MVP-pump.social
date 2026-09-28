/** Error from the data source, with the machine-readable code and payload. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
    public readonly status: number,
    public readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
