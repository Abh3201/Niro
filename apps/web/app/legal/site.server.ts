/**
 * Who runs this Niro site, for the privacy policy and terms. Each site that
 * runs Niro sets its own: Google's OAuth consent screen, for one, needs a
 * real person or organisation and a way to reach them.
 */
export interface Operator {
  /** `NIRO_OPERATOR`: a person or organisation, like "Ada Lovelace". */
  readonly name: string | null;
  /** `NIRO_CONTACT_EMAIL`: where privacy and account-deletion requests go. */
  readonly email: string | null;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function getOperator(): Operator {
  const name = process.env.NIRO_OPERATOR?.trim() || null;
  const email = process.env.NIRO_CONTACT_EMAIL?.trim() || null;
  return { name, email: email && EMAIL.test(email) ? email : null };
}
