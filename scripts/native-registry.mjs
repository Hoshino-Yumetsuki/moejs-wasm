import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolve } from "node:path"

export async function generateNativeRegistry(root) {
  await promisify(execFile)("go", ["run", resolve(root, "scripts/native-registry/main.go"), root], {
    cwd: root
  })
}
