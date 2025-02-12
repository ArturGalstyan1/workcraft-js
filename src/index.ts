import { v4 as uuidv4 } from "uuid";
import { SignJWT } from "jose";
type Subscriber = (message: Update) => void;
type Unsubscribe = () => void;

const TokenExpiration = 24 * 60 * 60; // 24 hours in seconds

interface PartialTaskPayload {
  task_args?: any[];
  task_kwargs?: Record<string, any>;
  prerun_handler_args?: any[];
  prerun_handler_kwargs?: Record<string, any>;
  postrun_handler_args?: any[];
  postrun_handler_kwargs?: Record<string, any>;
}

// Create a function to ensure defaults
const createDefaultTaskPayload = (
  partial: PartialTaskPayload = {},
): TaskPayload => ({
  task_args: partial.task_args ?? [],
  task_kwargs: partial.task_kwargs ?? {},
  prerun_handler_args: partial.prerun_handler_args ?? [],
  prerun_handler_kwargs: partial.prerun_handler_kwargs ?? {},
  postrun_handler_args: partial.postrun_handler_args ?? [],
  postrun_handler_kwargs: partial.postrun_handler_kwargs ?? {},
});

interface CreateTaskOptions {
  taskName: string;
  taskPayload?: PartialTaskPayload;
  queue?: string;
  retryOnFailure?: boolean;
  retryLimit?: number;
}

type TaskPayload = {
  task_args: any[];
  task_kwargs: Record<string, any>;
  prerun_handler_args: any[];
  prerun_handler_kwargs: Record<string, any>;
  postrun_handler_args: any[];
  postrun_handler_kwargs: Record<string, any>;
};

enum TaskStatus {
  PENDING = "PENDING",
  RUNNING = "RUNNING",
  SUCCESS = "SUCCESS",
  FAILURE = "FAILURE",
  INVALID = "INVALID",
  CANCELLED = "CANCELLED",
}

enum PeonStatus {
  IDLE = "IDLE",
  PREPARING = "PREPARING",
  WORKING = "WORKING",
  OFFLINE = "OFFLINE",
}

type Task = {
  id: string;
  task_name: string;
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

type Peon = {
  id: string;
  status: PeonStatus;
  last_heartbeat: Date;
  current_task: string | null;
  queues: string;
};

enum UpdateType {
  TASK_UPDATE = "task_update",
  PEON_UPDATE = "peon_update",
}

type Update = {
  type: UpdateType;
  message: {
    task?: Task;
    peon?: Peon;
  };
};

type WorkcraftConfig = {
  strongholdUrl: string;
  apiKey: string;
};

class WorkcraftClient {
  private config: WorkcraftConfig;
  private strongholdUrl: string;
  private apiKey: string | null = null;
  private fetchWithApiKey: typeof fetch = async (input, init) => {
    if (this.apiKey === null) throw new Error("No API key provided");
    return fetch(input, {
      ...init,
      headers: {
        ...init?.headers,
        WORKCRAFT_API_KEY: this.apiKey,
      },
    });
  };

  private sse: EventSource | null = null;
  private subscribers: Map<string, Subscriber> = new Map();
  private reconnectDelay: number = 5000; // Start with 1 second

  constructor(config: WorkcraftConfig) {
    this.config = config;
    this.strongholdUrl = config.strongholdUrl;
  }

  private async createJWT(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const secret = new TextEncoder().encode(this.config.apiKey);

    const jwt = await new SignJWT({ api_key: this.config.apiKey })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + TokenExpiration)
      .setNotBefore(now)
      .sign(secret);

    return jwt;
  }

  private async setupSSE(): Promise<void> {
    if (this.apiKey === null) {
      throw new Error("Client must be initialized before subscribing");
    }
    const url = `${this.strongholdUrl}/events?type=chieftain`;
    try {
      this.sse = new EventSource(url, { withCredentials: true });
    } catch (error) {
      console.error("Failed to create EventSource:", error);
      return;
    }

    this.sse.onopen = (event) => {
      console.log("SSE connection established");
    };

    this.sse.onmessage = (event) => {
      try {
        const update: Update = JSON.parse(event.data);
        this.notifySubscribers(update);
      } catch (error) {
        console.error("Failed to parse SSE message:", error);
      }
    };

    this.sse.onerror = (error: any) => {
      console.error("SSE error:", error);
    };
  }

  private notifySubscribers(update: Update): void {
    this.subscribers.forEach((subscriber) => {
      try {
        subscriber(update);
      } catch (error) {
        console.error("Error in subscriber:", error);
      }
    });
  }

  async subscribe(callback: Subscriber): Promise<Unsubscribe> {
    if (!this.sse) {
      await this.setupSSE();
    }

    const id = uuidv4();
    this.subscribers.set(id, callback);

    return () => {
      this.subscribers.delete(id);

      if (this.subscribers.size === 0 && this.sse) {
        this.sse.close();
        this.sse = null;
      }
    };
  }

  async disconnect(): Promise<void> {
    if (this.sse) {
      this.sse.close();
      this.sse = null;
      this.subscribers.clear();
    }
  }

  async init(): Promise<void> {
    this.apiKey = this.config.apiKey;
    try {
      console.log("fetching", this.strongholdUrl + "/api/test");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      const res = await this.fetchWithApiKey(this.strongholdUrl + "/api/test", {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.status !== 200) {
        console.error(`Server responded with status ${res.status}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        if ("name" in error && error.name === "AbortError") {
          console.error("Connection timeout - server might be offline");
        } else {
          console.error(
            "Failed to connect to the stronghold server:",
            error.message,
          );
        }
      } else {
        console.error("Failed to connect to the stronghold server:", error);
      }
    }
  }

  async createTaskOrThrow({
    taskName,
    taskPayload = {},
    queue = "DEFAULT",
    retryOnFailure = false,
    retryLimit = 0,
  }: CreateTaskOptions): Promise<Task | null> {
    const res = await this.fetchWithApiKey(this.strongholdUrl + "/api/task", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: uuidv4(),
        task_name: taskName,
        queue,
        retry_on_failure: retryOnFailure,
        retry_limit: retryLimit,
        payload: createDefaultTaskPayload(taskPayload),
      }),
    });
    if (res.status !== 201) {
      throw new Error("Failed to create a task: " + (await res.text()));
    }
    return res.json();
  }

  async getTaskByIdOrThrow(id: string): Promise<Task> {
    const res = await this.fetchWithApiKey(
      this.strongholdUrl + "/api/task/" + id,
    );
    if (res.status !== 200) {
      throw new Error("Failed to get task by id: " + (await res.text()));
    }
    return res.json();
  }

  async getPeonByIdOrThrow(id: string): Promise<Peon> {
    const res = await this.fetchWithApiKey(
      this.strongholdUrl + "/api/peon/" + id,
    );
    if (res.status !== 200) {
      throw new Error("Failed to get peon by id: " + (await res.text()));
    }
    return res.json();
  }

  async cancelTaskOrThrow(id: string) {
    const res = await this.fetchWithApiKey(
      this.strongholdUrl + "/api/task/" + id + "/cancel",
      {
        method: "POST",
      },
    );
    if (res.status !== 200) {
      throw new Error("Failed to cancel task: " + (await res.text()));
    }
  }
}

export {
  TaskStatus,
  PeonStatus,
  UpdateType,
  WorkcraftClient,
  // Add type exports
  type WorkcraftConfig,
  type PartialTaskPayload,
  type CreateTaskOptions,
  type TaskPayload,
  type Task,
  type Peon,
  type Update,
};
