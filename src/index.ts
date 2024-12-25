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
  config: WorkcraftConfig;
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
  host: string;
  port: number;
  apiKey: string;
};

class WorkcraftClient {
  private config: WorkcraftConfig;
  private strongholdUrl: string;
  private hashedApiKey: string | null = null;
  private fetchWithApiKey: typeof fetch = async (input, init) => {
    if (this.hashedApiKey === null)
      throw new Error("API key is not hashed yet.");
    return fetch(input, {
      ...init,
      headers: {
        ...init?.headers,
        WORKCRAFT_API_KEY: this.hashedApiKey,
      },
    });
  };

  private websocket: WebSocket | null = null;
  private subscribers: Map<string, Subscriber> = new Map();
  private reconnectDelay: number = 5000; // Start with 1 second

  constructor(config: WorkcraftConfig) {
    this.config = config;
    this.strongholdUrl = config.host + ":" + config.port;
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

  private async setupWebSocket(): Promise<void> {
    if (this.hashedApiKey === null) {
      throw new Error("Client must be initialized before subscribing");
    }

    // Create and set the JWT
    const jwt = await this.createJWT();
    const wsProtocol = this.strongholdUrl.startsWith("https") ? "wss" : "ws";
    const wsUrl = `${wsProtocol}://${this.strongholdUrl.replace(/^https?:\/\//, "")}/ws/chieftain`;

    this.websocket = new WebSocket(wsUrl, jwt);

    this.websocket.onopen = (event) => {
      console.log("WebSocket connection established");
    };

    this.websocket.onmessage = (event) => {
      try {
        const update: Update = JSON.parse(event.data);
        this.notifySubscribers(update);
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    this.websocket.onclose = () => {
      this.handleWebSocketClose();
    };

    this.websocket.onerror = (error: any) => {
      if (error.message) {
        console.error("WebSocket error:", error.message);
      } else {
        console.error("WebSocket error:", error);
      }
    };
  }

  private handleWebSocketClose(): void {
    setTimeout(() => {
      this.setupWebSocket().catch((error) => {
        console.error(
          "Failed to reconnect:",
          error,
          "Retrying in",
          this.reconnectDelay,
          "ms",
        );
      });
    }, this.reconnectDelay);
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
    if (!this.websocket) {
      await this.setupWebSocket();
    }

    const id = uuidv4();
    this.subscribers.set(id, callback);

    return () => {
      this.subscribers.delete(id);

      // If this was the last subscriber, close the WebSocket
      if (this.subscribers.size === 0 && this.websocket) {
        this.websocket.close();
        this.websocket = null;
      }
    };
  }

  // Add a method to manually close the connection
  async disconnect(): Promise<void> {
    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
      this.subscribers.clear();
    }
  }

  async init(): Promise<void> {
    const encoder = new TextEncoder();
    const data = encoder.encode(this.config.apiKey);
    const buffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(buffer));
    this.hashedApiKey = hashArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
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
