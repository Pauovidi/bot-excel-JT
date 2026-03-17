import { resetDemoState } from "../lib/stateStore";

async function main() {
  await resetDemoState();
  console.log("demo-state.json reiniciado");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
