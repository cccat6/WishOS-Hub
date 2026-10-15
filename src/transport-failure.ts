/** A transport receipt distinguishes refusal before dispatch from a lost reply. */
export class TransportFailure extends Error {
  constructor(
    code: string,
    readonly dispatched: boolean,
  ) {
    super(code);
    this.name = 'TransportFailure';
  }
}
