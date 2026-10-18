local M = {}

local skill_dir = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h")

local function run(args, on_done)
  vim.system({ "bun", "scripts/send-diff.ts", unpack(args) }, { cwd = skill_dir, text = true }, function(result)
    vim.schedule(function()
      on_done(result)
    end)
  end)
end

local function notify_result(result)
  if result.code == 0 then
    vim.notify(vim.trim(result.stdout), vim.log.levels.INFO)
  else
    vim.notify(vim.trim(result.stderr ~= "" and result.stderr or result.stdout), vim.log.levels.ERROR)
  end
end

function M.send_current_buffer_diff()
  local file_path = vim.api.nvim_buf_get_name(0)
  if file_path == "" then
    vim.notify("Buffer has no file", vim.log.levels.ERROR)
    return
  end

  run({ file_path }, function(result)
    if result.code ~= 0 then
      notify_result(result)
      return
    end

    local ok, parsed = pcall(vim.json.decode, result.stdout)
    if ok and type(parsed) == "table" and parsed.needsSelection then
      vim.ui.select(parsed.candidates, { prompt = "Send diff to Claude session:" }, function(choice)
        if not choice then
          return
        end
        run({ file_path, "--project", choice }, notify_result)
      end)
      return
    end

    notify_result(result)
  end)
end

function M.setup(opts)
  opts = opts or {}
  vim.api.nvim_create_user_command("ClaudeSendDiff", M.send_current_buffer_diff, {
    desc = "Send current buffer's git diff to a running Claude Code channel",
  })
end

return M
