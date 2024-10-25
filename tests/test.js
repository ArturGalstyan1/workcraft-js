import { assertTablesSetup, createTask, getTaskById } from "../dist/index.js";

let config = {
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "workcraft",
  database: "workcraft",
};

async function main() {
  try {
    let result = await assertTablesSetup(config);
    console.log("Tables setup:", result);

    result = await getTaskById("c4e7ee02-7099-4cf3-95f1-fe94045e1a7e", config);
    console.log("Task by ID:", result);

    result = await createTask({
      taskName: "simpleTask",
      taskPayload: { task_args: [] },
    });
    console.log("Task created:", result);
  } catch (error) {
    console.error("Error in main function:", error);
  } finally {
    console.log("Done");
  }
}

main();
