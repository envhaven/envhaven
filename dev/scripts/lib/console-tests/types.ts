export interface TestReporter {
  pass(message: string): void;
  fail(message: string): void;
}
