export type TaskPayload = {
  name: string;
  task_args: any[];
  task_kwargs: Record<string, any>;
  prerun_handler_args: any[];
  prerun_handler_kwargs: Record<string, any>;
  postrun_handler_args: any[];
  postrun_handler_kwargs: Record<string, any>;
};

export enum TaskStatus {
  PENDING = "PENDING",
  RUNNING = "RUNNING",
  SUCCESS = "SUCCESS",
  FAILURE = "FAILURE",
  INVALID = "INVALID",
}

export type Task = {
  id: string;
  status: TaskStatus;
  created_at: Date;
  updated_at: Date;
  worker_id: string | null;
  queue: string;
  payload: TaskPayload;
  result: any | null;
  retry_on_failure: boolean;
  retry_count: number;
  retry_limit: number;
};

export type MySQLConnectionConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};
