import { execFileSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const check = process.argv.includes("--check")
const output = execFileSync("gofmt", [check ? "-l" : "-w", "bridge", "scripts/native-registry"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"]
})
if (check && output) {
  console.error(`Go files need formatting:\n${output.trimEnd()}`)
  process.exitCode = 1
}
