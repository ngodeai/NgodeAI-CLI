import { isBunTestRuntime } from "@ngodeai/utils/env";

process.stdout.write(JSON.stringify(isBunTestRuntime()));
