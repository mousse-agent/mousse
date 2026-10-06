#include <node_api.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <cerrno>
#include <string>
#include <vector>

static napi_value fail(napi_env env, const char* code) {
  napi_throw_error(env, code, code);
  return nullptr;
}

static std::string text(napi_env env, napi_value value) {
  size_t n = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &n) != napi_ok || n > 4096) return {};
  std::vector<char> bytes(n + 1);
  napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &n);
  return std::string(bytes.data(), n);
}

static bool integer(napi_env env, napi_value value, int32_t* out) {
  return napi_get_value_int32(env, value, out) == napi_ok;
}

static bool barrier(napi_env env, napi_value callback, int index) {
  napi_valuetype type;
  if (!callback || napi_typeof(env, callback, &type) != napi_ok || type != napi_function) return true;
  napi_value global, arg, result;
  napi_get_global(env, &global);
  napi_create_int32(env, index, &arg);
  return napi_call_function(env, global, callback, 1, &arg, &result) == napi_ok;
}

static int walk(napi_env env, int root, const std::string& path, bool directory, napi_value callback) {
  if (path.size() > 4096 || path.find('\0') != std::string::npos ||
      path.find('\\') != std::string::npos || (!path.empty() && path[0] == '/')) return -1;
  std::vector<std::string> parts;
  size_t begin = 0;
  while (begin < path.size()) {
    size_t end = path.find('/', begin);
    if (end == std::string::npos) end = path.size();
    std::string part = path.substr(begin, end - begin);
    if (part.empty() || part == "." || part == ".." || part.find(':') != std::string::npos) return -1;
    parts.push_back(part);
    begin = end + 1;
  }
  if (parts.size() > 64 || (!directory && parts.empty())) return -1;
  // A duplicate would share the root's directory read offset, so a second
  // listing of the root would start at its end. Open an independent description.
  int current = openat(root, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (current < 0) return -1;
  for (size_t i = 0; i < parts.size(); i++) {
    const bool dir = directory || i + 1 < parts.size();
    int next = openat(current, parts[i].c_str(),
                      O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | (dir ? O_DIRECTORY : 0));
    close(current);
    if (next < 0) return -1;
    current = next;
    if (!barrier(env, callback, static_cast<int>(i))) {
      close(current);
      return -1;
    }
  }
  return current;
}

static napi_value openRoot(napi_env env, napi_callback_info info) {
  size_t n = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &n, args, nullptr, nullptr);
  if (n != 1) return fail(env, "bad_request");
  const std::string path = text(env, args[0]);
  if (path.empty() || path.find('\0') != std::string::npos) return fail(env, "bad_request");
  int fd = open(path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return fail(env, "forbidden");
  napi_value result;
  napi_create_int32(env, fd, &result);
  return result;
}

static napi_value closeRoot(napi_env env, napi_callback_info info) {
  size_t n = 1;
  napi_value args[1];
  int32_t fd;
  napi_get_cb_info(env, info, &n, args, nullptr, nullptr);
  if (n != 1 || !integer(env, args[0], &fd) || fd < 0) return fail(env, "bad_request");
  if (close(fd) < 0) return fail(env, "forbidden");
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value readFile(napi_env env, napi_callback_info info) {
  size_t n = 4;
  napi_value args[4];
  int32_t root, max;
  napi_get_cb_info(env, info, &n, args, nullptr, nullptr);
  if (n < 3 || !integer(env, args[0], &root) || !integer(env, args[2], &max) || root < 0 ||
      max < 1 || max > 262144) return fail(env, "bad_request");
  const std::string path = text(env, args[1]);
  if (path.empty()) return fail(env, "forbidden");
  int fd = walk(env, root, path, false, n == 4 ? args[3] : nullptr);
  if (fd < 0) return fail(env, "forbidden");
  struct stat before;
  if (fstat(fd, &before) < 0 || !S_ISREG(before.st_mode) || before.st_nlink != 1) {
    close(fd);
    return fail(env, "forbidden");
  }
  if (before.st_size > max) {
    close(fd);
    return fail(env, "too_large");
  }
  std::vector<char> bytes(static_cast<size_t>(max) + 1);
  ssize_t count = 0;
  while (count <= max) {
    ssize_t got = read(fd, bytes.data() + count, static_cast<size_t>(max + 1 - count));
    if (got < 0) {
      if (errno == EINTR) continue;
      close(fd);
      return fail(env, "forbidden");
    }
    if (got == 0) break;
    count += got;
  }
  struct stat after;
  const bool stable = fstat(fd, &after) == 0 && before.st_dev == after.st_dev &&
                      before.st_ino == after.st_ino && after.st_nlink == 1;
  close(fd);
  if (!stable) return fail(env, "forbidden");
  if (count > max) return fail(env, "too_large");
  napi_value result;
  void* copy;
  napi_create_buffer_copy(env, static_cast<size_t>(count), bytes.data(), &copy, &result);
  return result;
}

static napi_value listDirectory(napi_env env, napi_callback_info info) {
  size_t n = 4;
  napi_value args[4];
  int32_t root, max;
  napi_get_cb_info(env, info, &n, args, nullptr, nullptr);
  if (n < 3 || !integer(env, args[0], &root) || !integer(env, args[2], &max) || root < 0 ||
      max < 1 || max > 4096) return fail(env, "bad_request");
  const std::string path = text(env, args[1]);
  int fd = walk(env, root, path, true, n == 4 ? args[3] : nullptr);
  if (fd < 0) return fail(env, "forbidden");
  DIR* dir = fdopendir(fd);
  if (!dir) {
    close(fd);
    return fail(env, "forbidden");
  }
  napi_value result;
  napi_create_array(env, &result);
  uint32_t index = 0;
  errno = 0;
  while (dirent* entry = readdir(dir)) {
    std::string name(entry->d_name);
    if (name == "." || name == "..") continue;
    if (index >= static_cast<uint32_t>(max)) {
      closedir(dir);
      return fail(env, "too_large");
    }
    struct stat item;
    const char* kind = "blocked";
    if (fstatat(dirfd(dir), entry->d_name, &item, AT_SYMLINK_NOFOLLOW) == 0) {
      if (S_ISREG(item.st_mode) && item.st_nlink == 1) kind = "file";
      else if (S_ISDIR(item.st_mode)) kind = "directory";
    }
    napi_value row, a, b;
    napi_create_object(env, &row);
    napi_create_string_utf8(env, name.c_str(), name.size(), &a);
    napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &b);
    napi_set_named_property(env, row, "name", a);
    napi_set_named_property(env, row, "kind", b);
    napi_set_element(env, result, index++, row);
    errno = 0;
  }
  const int error = errno;
  closedir(dir);
  if (error) return fail(env, "forbidden");
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
      {"openRoot", nullptr, openRoot, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"closeRoot", nullptr, closeRoot, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"read", nullptr, readFile, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"list", nullptr, listDirectory, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, 4, methods);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
