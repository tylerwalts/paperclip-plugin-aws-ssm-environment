/** Single-quote a value for safe interpolation into an SSM shell command. */
export function shellQuoteForSsm(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
