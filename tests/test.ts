import type { WorkcraftConfig } from "../dist/index.js";
import { WorkcraftClient } from "../dist/index.js";

let config: WorkcraftConfig = {
  host: "http://localhost",
  port: 6112,
  apiKey: "abcd",
};
async function main() {
  try {
    const workcraftClient = new WorkcraftClient(config);
    await workcraftClient.init();

    workcraftClient.subscribe((msg) => {
      console.log("Received message:", msg);
    });
    const task = await workcraftClient.createTaskOrThrow({
      taskName: "simple_task",
      taskPayload: {
        task_args: ["aaaaa"],
      },
    });

    console.log("Task created:", task);
  } catch (error) {
    console.error("Error in main function:", error);
  } finally {
    console.log("Done");
  }
}
main();
