const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const WEB_VERSION = "1.0.0";
const sandboxDir = path.join(__dirname, "storage");
if (!fs.existsSync(sandboxDir)) fs.mkdirSync(sandboxDir);

setInterval(() => {
  fs.readdir(sandboxDir, (err, files) => {
    if (err) return;
    for (const file of files) {
      const filePath = path.join(sandboxDir, file);
      fs.rm(filePath, { recursive: true, force: true }, () => {});
    }
  });
}, 86400000);

const workingDirs = new Map();

io.on("connection", (socket) => {
  workingDirs.set(socket.id, sandboxDir);

  socket.on("command", (cmd) => {
    if (!cmd || cmd.trim() === "") return;
    let currentDir = workingDirs.get(socket.id);

    if (cmd.trim().toLowerCase() === "version") {
      socket.emit("output", `Web ${WEB_VERSION}`);
      return;
    }

    if (cmd.trim().startsWith("cd ")) {
      const targetDir = cmd.trim().slice(3).trim();
      let newDir;
      if (targetDir === "" || targetDir === ".") {
        socket.emit("output", `Current directory: ${currentDir}`);
        socket.emit("current_path", formatWindowsPath(currentDir));
        return;
      } else if (targetDir === "..") {
        newDir = path.resolve(currentDir, "..");
      } else if (path.isAbsolute(targetDir)) {
        newDir = path.resolve(sandboxDir, targetDir.replace(/^[\/\\]+/, ""));
      } else {
        newDir = path.resolve(currentDir, targetDir);
      }
      if (!newDir.startsWith(sandboxDir)) {
        socket.emit("output", "Error: Cannot navigate outside the storage directory.");
        return;
      }
      if (!fs.existsSync(newDir) || !fs.statSync(newDir).isDirectory()) {
        socket.emit("output", `Error: Directory '${targetDir}' does not exist.`);
        return;
      }
      workingDirs.set(socket.id, newDir);
      socket.emit("output", `Changed directory to: ${newDir}`);
      socket.emit("current_path", formatWindowsPath(newDir));
      return;
    }

    if (cmd.trim().startsWith("nano ")) {
      const fileName = cmd.trim().slice(5).trim();
      if (!isSafeFileName(fileName)) {
        socket.emit("output", "Error: Invalid or unsafe file name.");
        return;
      }
      const filePath = path.join(currentDir, fileName);
      if (!filePath.startsWith(sandboxDir)) {
        socket.emit("output", "Error: Cannot access files outside storage.");
        return;
      }
      socket.emit("nano_open", { file: fileName });
      return;
    }

    let execCmd = cmd;
    if (os.platform() === "win32" && cmd.trim() === "ls") execCmd = "dir";
    const parts = execCmd.split(" ");
    const mainCmd = parts[0];
    const args = parts.slice(1);
    const child = spawn(mainCmd, args, { cwd: currentDir, shell: true });

    child.stdout.on("data", (data) => socket.emit("output", data.toString()));
    child.stderr.on("data", (data) => socket.emit("output", data.toString()));
    child.on("close", (code) => {
      socket.emit("output", `[Process exited with code ${code}]`);
      socket.emit("current_path", formatWindowsPath(currentDir));
    });
  });

  socket.on("nano_load", (data) => {
    const fileName = data.file;
    if (!isSafeFileName(fileName)) {
      socket.emit("output", "Error: Invalid or unsafe file name.");
      return;
    }
    const filePath = path.join(workingDirs.get(socket.id), fileName);
    if (!filePath.startsWith(sandboxDir)) {
      socket.emit("output", "Error: Cannot access files outside storage.");
      return;
    }
    fs.readFile(filePath, "utf8", (err, content) => {
      if (err) {
        if (err.code === "ENOENT") socket.emit("nano_content", { content: "" });
        else socket.emit("output", `Error: Unable to read file ${fileName}`);
      } else socket.emit("nano_content", { content });
    });
  });

  socket.on("nano_save", (data) => {
    const { file, content } = data;
    if (!isSafeFileName(file)) {
      socket.emit("output", "Error: Invalid or unsafe file name.");
      return;
    }
    const filePath = path.join(workingDirs.get(socket.id), file);
    if (!filePath.startsWith(sandboxDir)) {
      socket.emit("output", "Error: Cannot save file outside storage.");
      return;
    }
    fs.writeFile(filePath, content, "utf8", (err) => {
      if (err) socket.emit("output", `Error: Failed to save file ${file}`);
      else socket.emit("output", `File ${file} saved successfully.`);
    });
  });

  socket.on("disconnect", () => {
    workingDirs.delete(socket.id);
  });
});

function isSafeFileName(fileName) {
  if (!fileName || typeof fileName !== "string") return false;
  const safePattern = /^[a-zA-Z0-9\s!@#$%^&*()_+\-=\[\]{};:'",.<>/?\\|`~]+$/;
  return safePattern.test(fileName) && !fileName.includes("..");
}

function formatWindowsPath(dir) {
  const relativePath = path.relative(sandboxDir, dir);
  return relativePath
    ? `C:\\Storage\\${relativePath.replace(/\//g, "\\")}`
    : "C:\\Storage";
}

const PORT = process.env.PORT || 3000;
let host = "localhost";
app.use((req, res, next) => {
  host = req.get("host");
  next();
});
app.use(express.static(__dirname + "/public"));

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log("Sandbox dir:", sandboxDir);
});

setInterval(() => {
  const [hostname, port] = host.split(":");
  const options = { hostname: hostname || "localhost", port: port || PORT, path: "/", method: "GET" };
  const req = http.request(options, () => {});
  req.on("error", () => {});
  req.end();
}, 60 * 1000);
