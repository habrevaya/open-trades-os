/**
 * An address without the slashes at its end.
 *
 * A loop rather than `replace(/\/+$/, "")`: that pattern retries from every
 * slash in a long run of them, which is quadratic on input a caller does not
 * control. This walks back from the end once.
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return end === value.length ? value : value.slice(0, end);
}
