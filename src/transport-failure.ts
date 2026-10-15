/** A transport receipt distinguishes refusal before dispatch from a lost reply. */
export class TransportFailure extends Error {
  recoveryExhausted = false;
  constructor(
    code: string,
    readonly dispatched: boolean,
  ) {
    super(code);
    this.name = 'TransportFailure';
  }
}
