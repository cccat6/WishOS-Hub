/** Authoritative native completion, distinct from a lost receipt or transport failure.
 * A failed/interrupted turn can have earlier tool effects; it is never replayed. */
export class HarnessTurnEnded extends Error {
  constructor(
    message: string,
    readonly outcome: 'failed' | 'interrupted',
  ) {
    super(message);
    this.name = 'HarnessTurnEnded';
  }
}
