import * as Types from "./types.js";
import mysql, { Connection } from "mysql2/promise";
import { v4 as uuidv4 } from "uuid";

interface PartialTaskPayload {
  task_args?: any[];
  task_kwargs?: Record<string, any>;
  prerun_handler_args?: any[];
  prerun_handler_kwargs?: Record<string, any>;
  postrun_handler_args?: any[];
  postrun_handler_kwargs?: Record<string, any>;
}

interface CreateTaskOptions {
  taskName: string;
  taskPayload?: PartialTaskPayload;
  queue?: string;
  retryOnFailure?: boolean;
  retryLimit?: number;
  config: Types.MySQLConnectionConfig;
}

/**
 * Checks if the required tables are set up in the database.
 * @param config - The MySQL connection configuration.
 * @returns True if the tables are set up, false otherwise.
 */
export async function assertTablesSetup(
  config: Types.MySQLConnectionConfig,
): Promise<boolean> {
  let connection: Connection | null = null;
  try {
    connection = await mysql.createConnection(config);
    const [rows] = await connection.query(
      `
      SELECT TABLE_NAME
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('peon', 'bountyboard')
    `,
      [config.database],
    );

    const existingTables = new Set(
      (rows as any[]).map((row) => row.TABLE_NAME),
    );

    const requiredTables = ["peon", "bountyboard"];
    const allTablesExist = requiredTables.every((table) =>
      existingTables.has(table),
    );

    if (!allTablesExist) {
      const missingTables = requiredTables.filter(
        (table) => !existingTables.has(table),
      );
      console.error(`Missing tables: ${missingTables.join(", ")}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Error checking tables:", error);
    return false;
  } finally {
    if (connection) {
      connection.end();
    }
  }
}

/**
 * Retrieves a task from the bountyboard table by its ID.
 *
 * @param id - The ID of the task to retrieve.
 * @param config - MySQL connection configuration.
 * @returns A Promise that resolves to the Task object, or null if the task is not found.
 * @throws {Error} If the database tables are not set up.
 */
export const getTaskById = async (
  id: string,
  config: Types.MySQLConnectionConfig,
): Promise<Types.Task | null> => {
  if (!assertTablesSetup(config)) {
    throw new Error(
      "Tables not set up. Run `python3 -m workcraft setup_database_tables` to set up tables.",
    );
  }
  const connection = await mysql.createConnection(config);
  try {
    const [results] = await connection.query(
      `
      SELECT *
      FROM bountyboard
      WHERE id = ?
    `,
      [id],
    );

    if (Array.isArray(results) && results.length > 0) {
      const task = results[0] as Types.Task;
      return task;
    }
    return null;
  } finally {
    connection.end();
  }
};

/**
 * Creates a new task in the bountyboard table with simplified interface and default values.
 *
 * @param options - The options for creating the task
 * @returns A Promise that resolves to the created Task object, or null if creation failed.
 * @throws {Error} If the database tables are not set up.
 * @throws {Error} If there's an error during task creation or retrieval.
 *
 * @example
 * const vectorizeTask = await createTask({
 *   taskName: 'vectorize',
 *   taskPayload: {
 *     task_kwargs: {
 *       args: {
 *         docs: docs,
 *         file: file
 *       }
 *     },
 *     postrun_handler_kwargs: {
 *       user: user,
 *       callback_url: `${ORIGIN}/api/file/${fileId}/callback/vectorize`,
 *       file: file
 *     }
 *   },
 *   queue: VECTORIZE_QUEUE_NAME,
 *   config: config
 * });
 */
export const createTask = async ({
  taskName,
  taskPayload = {},
  queue = "DEFAULT",
  retryOnFailure = false,
  retryLimit = 0,
  config,
}: CreateTaskOptions): Promise<Types.Task | null> => {
  let connection;
  try {
    // Check if tables are set up
    if (!(await assertTablesSetup(config))) {
      throw new Error(
        "Tables not set up. Run `python3 -m workcraft setup_database_tables` to set up tables.",
      );
    }

    connection = await mysql.createConnection(config);
    const taskId = uuidv4();
    const now = new Date();

    // Fill in default values for optional payload fields to match TaskPayload type
    const fullTaskPayload: Types.TaskPayload = {
      task_args: [],
      task_kwargs: {},
      prerun_handler_args: [],
      prerun_handler_kwargs: {},
      postrun_handler_args: [],
      postrun_handler_kwargs: {},
      ...taskPayload,
    };

    // Prepare the task object
    const task: Omit<Types.Task, "result"> = {
      id: taskId,
      task_name: taskName,
      status: Types.TaskStatus.PENDING,
      created_at: now,
      updated_at: now,
      worker_id: null,
      queue,
      payload: JSON.stringify(fullTaskPayload) as unknown as Types.TaskPayload,
      retry_on_failure: retryOnFailure,
      retry_limit: retryLimit,
      retry_count: 0,
    };

    // Insert the task
    await connection.query(
      `
      INSERT INTO bountyboard SET ?
      `,
      task,
    );

    // Fetch the inserted task to return
    return await getTaskById(taskId, config);
  } catch (error) {
    console.error("Error creating task:", error);
    throw error;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
};

/**
 * Deletes a task from the bountyboard table by its ID if the task is in the PENDING state.
 *
 *
 * @param id
 * @param config
 * @returns A Promise that resolves to true if the task was deleted, false otherwise.
 * @throws {Error} If the database tables are not set up.
 */

export const deleteTask = async (
  id: string,
  config: Types.MySQLConnectionConfig,
): Promise<boolean> => {
  if (!assertTablesSetup(config)) {
    throw new Error(
      "Tables not set up. Run `python3 -m workcraft setup_database_tables` to set up tables.",
    );
  }
  const connection = await mysql.createConnection(config);
  try {
    const [results] = await connection.query(
      `
      DELETE FROM bountyboard
      WHERE id = ? AND status = 'PENDING'
    `,
      [id],
    );

    if (Array.isArray(results) && results.length > 0) {
      return true;
    }
    return false;
  } finally {
    connection.end();
  }
};
