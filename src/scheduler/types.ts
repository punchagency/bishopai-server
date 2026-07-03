export interface Job {
  name: string;
  /** cron expression (node-cron: `m h dom mon dow`). */
  schedule: string;
  run: () => Promise<void>;
}
