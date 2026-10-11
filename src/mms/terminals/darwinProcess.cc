#include <node_api.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <unistd.h>
#include <signal.h>
#include <cerrno>
#include <string>

static napi_value error(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message); return nullptr;
}
static bool pid_arg(napi_env env, napi_value value, int32_t& pid) {
  double number;
  return napi_get_value_double(env, value, &number) == napi_ok && number > 0 &&
    number <= INT32_MAX && number == static_cast<int32_t>(number) &&
    (pid = static_cast<int32_t>(number)) != getpid();
}
static bool read_info(napi_env env, int32_t pid, proc_bsdinfo& info, bool& gone) {
  errno = 0;
  const int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (bytes == 0 && errno == ESRCH) { gone = true; return true; }
  if (bytes != sizeof(info) || info.pbi_pid != static_cast<uint32_t>(pid) ||
      info.pbi_start_tvsec == 0 || info.pbi_start_tvusec >= 1000000) {
    error(env, "Cannot establish owned process identity"); return false;
  }
  gone = info.pbi_status == SZOMB;
  return true;
}
static std::string birth(const proc_bsdinfo& info) {
  return std::to_string(info.pbi_start_tvsec) + ":" + std::to_string(info.pbi_start_tvusec);
}
static napi_value read_process(napi_env env, napi_callback_info call) {
  size_t count = 1; napi_value args[1]; int32_t pid;
  napi_get_cb_info(env, call, &count, args, nullptr, nullptr);
  if (count != 1 || !pid_arg(env, args[0], pid)) return error(env, "Invalid owned PID");
  proc_bsdinfo info{}; bool gone;
  if (!read_info(env, pid, info, gone)) return nullptr;
  napi_value result;
  if (gone) { napi_get_null(env, &result); return result; }
  napi_create_object(env, &result);
  napi_value value;
  napi_create_int32(env, pid, &value); napi_set_named_property(env, result, "pid", value);
  napi_create_uint32(env, info.pbi_ppid, &value); napi_set_named_property(env, result, "parent", value);
  const auto started = birth(info);
  napi_create_string_utf8(env, started.c_str(), started.size(), &value);
  napi_set_named_property(env, result, "startedAt", value);
  return result;
}
static napi_value children(napi_env env, napi_callback_info call) {
  size_t count = 1; napi_value args[1]; int32_t pid;
  napi_get_cb_info(env, call, &count, args, nullptr, nullptr);
  if (count != 1 || !pid_arg(env, args[0], pid)) return error(env, "Invalid owned PID");
  // One extra slot distinguishes an exhaustive bounded list from truncation.
  pid_t pids[257]{}; errno = 0;
  // Apple's wrapper returns a PID count, unlike proc_listpids' byte count.
  const int entries = proc_listchildpids(pid, pids, sizeof(pids));
  if (entries < 0 || (entries == 0 && errno != 0 && errno != ESRCH) ||
      entries >= 257) return error(env, "Owned child inventory unavailable or too large");
  napi_value result; napi_create_array(env, &result); uint32_t index = 0;
  for (int offset = 0; offset < entries; ++offset) {
    if (pids[offset] <= 0 || pids[offset] == pid || pids[offset] == getpid()) return error(env, "Invalid owned child inventory");
    napi_value value; napi_create_int32(env, pids[offset], &value);
    napi_set_element(env, result, index++, value);
  }
  return result;
}
static napi_value signal_process(napi_env env, napi_callback_info call) {
  size_t count = 3; napi_value args[3]; int32_t pid, signal;
  napi_get_cb_info(env, call, &count, args, nullptr, nullptr);
  if (count != 3 || !pid_arg(env, args[0], pid) || napi_get_value_int32(env, args[2], &signal) != napi_ok ||
      (signal != SIGTERM && signal != SIGKILL)) return error(env, "Invalid owned signal");
  char expected[64]{}; size_t length;
  if (napi_get_value_string_utf8(env, args[1], expected, sizeof(expected), &length) != napi_ok || length >= sizeof(expected) - 1)
    return error(env, "Invalid owned birth identity");
  proc_bsdinfo info{}; bool gone;
  if (!read_info(env, pid, info, gone)) return nullptr;
  bool sent = false;
  if (!gone && birth(info) == std::string(expected, length)) {
    if (kill(pid, signal) == 0) sent = true;
    else if (errno != ESRCH) return error(env, "Owned process signal denied");
  }
  napi_value result; napi_get_boolean(env, sent, &result); return result;
}
static napi_value init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"read", nullptr, read_process, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"children", nullptr, children, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"signal", nullptr, signal_process, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, 3, properties); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
