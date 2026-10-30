"""在目标服务器上下载 Docker 构建所需的全部 wheel（离线 wheelhouse）。

用法：
    python3 -u deploy/fetch_wheels.py --requirements backend/requirements.txt --out wheelhouse

脚本通过 PyPI JSON API 解析依赖（含传递依赖），从清华镜像下载 manylinux x86_64 / py3 通用 wheel，
并额外下载 rapidocr-onnxruntime==1.4.4（--no-deps 安装）。已存在的 wheel 会跳过。
"""
import argparse
import json
import ssl
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

try:
    from pip._vendor.packaging.markers import default_environment
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.version import Version
except Exception as exc:  # pragma: no cover
    print("需要系统 pip 提供的 packaging 库：", exc)
    sys.exit(2)

MIRRORS = [
    "https://pypi.tuna.tsinghua.edu.cn",
    "https://mirrors.aliyun.com/pypi",
]
EXTRA_PACKAGES = ["rapidocr-onnxruntime==1.4.4"]
ENV = None


def http_get(url: str, timeout: int = 60) -> bytes:
    # 优先 curl（大 JSON / 大文件下载速度快且稳定），失败则退回 urllib
    if url.startswith("http"):
        curl = subprocess.run(
            ["curl", "-fsSL", "--retry", "3", "--retry-delay", "2",
             "--connect-timeout", "15", "--max-time", str(max(timeout, 120)), url],
            capture_output=True,
        )
        if curl.returncode == 0 and curl.stdout:
            return curl.stdout
    ctx = ssl.create_default_context()
    request = urllib.request.Request(url, headers={"User-Agent": "bp-wheel-fetch/1.0"})
    with urllib.request.urlopen(request, timeout=timeout, context=ctx) as response:
        return response.read()


def http_get_retry(url: str, attempts: int = 6, timeout: int = 60) -> bytes:
    last_error = None
    for attempt in range(attempts):
        try:
            return http_get(url, timeout=timeout)
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            time.sleep(min(5, 1 + attempt))
    raise last_error


def load_requirements(path: Path) -> list:
    result = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        result.append(Requirement(line))
    for extra in EXTRA_PACKAGES:
        result.append(Requirement(extra))
    return result


def choose_file(files: list):
    def score(name: str) -> int:
        if not name.endswith(".whl"):
            return -1
        if "cp312" in name and ("manylinux" in name or "linux_x86_64" in name):
            value = 100
        elif "-abi3-" in name and "manylinux" in name:
            value = 92  # cp37-abi3 等 ABI3 wheel 也可用于 CPython 3.12
        elif "py3-none-any" in name or "py2.py3-none-any" in name:
            value = 60
        elif "cp39-abi3" in name and "manylinux" in name:
            value = 50
        else:
            return -1
        if "manylinux2014_x86_64" in name or "manylinux_2_17_x86_64" in name:
            value += 10
        elif "manylinux_2_28_x86_64" in name or "manylinux_2_27_x86_64" in name:
            value += 8
        return value

    best = None
    best_score = -1
    for item in files:
        value = score(item["filename"])
        if value > best_score:
            best_score = value
            best = item
    return best


def fetch_index(name: str) -> dict:
    return json.loads(http_get_retry(f"https://pypi.org/pypi/{name}/json").decode("utf-8"))


def pick_version(data: dict, specifier):
    candidates = []
    for version_text in data["releases"].keys():
        try:
            version = Version(version_text)
        except Exception:  # noqa: BLE001
            continue
        if version.is_prerelease:
            continue
        if specifier and not specifier.contains(version):
            continue
        candidates.append(version)
    candidates.sort(reverse=True)
    for version in candidates:
        files = data["releases"].get(str(version)) or []
        chosen = choose_file(files)
        if chosen is not None:
            return version, chosen
    return None, None


def mirror_urls(item: dict) -> list:
    path = item["url"].split("files.pythonhosted.org", 1)[-1]
    if not path.startswith("/"):
        path = "/" + path
    return [mirror + path for mirror in MIRRORS]


def download_wheel(item: dict, out_dir: Path) -> Path:
    filename = item["filename"]
    target = out_dir / filename
    if target.exists() and target.stat().st_size == item.get("size", target.stat().st_size):
        print(f"  skip {filename} (已存在)", flush=True)
        return target
    last_error = None
    for url in mirror_urls(item):
        tmp = out_dir / (filename + ".part")
        # 优先用 curl，部分网络环境下比 urllib 更稳定、更快
        curl = subprocess.run(
            [
                "curl", "-fsSL", "--retry", "5", "--retry-delay", "2",
                "--connect-timeout", "15", "--max-time", "300",
                "-o", str(tmp), url,
            ],
            capture_output=True,
        )
        if curl.returncode == 0 and tmp.exists() and tmp.stat().st_size == item.get("size", tmp.stat().st_size):
            tmp.replace(target)
            print(f"  ok {filename} ({target.stat().st_size / 1048576:.1f} MB)", flush=True)
            return target
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        for _ in range(3):
            try:
                data = http_get(url, timeout=120)
                if len(data) != item.get("size", len(data)):
                    raise IOError(f"size mismatch {len(data)} != {item.get('size')}")
                target.write_bytes(data)
                print(f"  ok(urllib) {filename} ({len(data) / 1048576:.1f} MB)", flush=True)
                return target
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                time.sleep(1.5)
    raise RuntimeError(f"下载失败 {filename}: {last_error}")


def wheel_metadata_requirements(path: Path) -> list:
    with zipfile.ZipFile(path) as archive:
        metadata_name = next(
            (name for name in archive.namelist() if name.endswith(".dist-info/METADATA")), None
        )
        if metadata_name is None:
            return []
        text = archive.read(metadata_name).decode("utf-8", "replace")
    requires = []
    for line in text.splitlines():
        if line.lower().startswith("requires-dist:"):
            requires.append(line.split(":", 1)[1].strip())
    return requires


def find_existing(out_dir: Path, requirement, specifier):
    """优先复用 wheelhouse 里已有的 wheel，避免为每个包请求 PyPI JSON。"""
    try:
        from pip._vendor.packaging.utils import canonicalize_name
    except Exception:  # noqa: BLE001
        canonicalize_name = lambda value: value.lower().replace("_", "-")  # noqa: E731
    target_name = canonicalize_name(requirement.name)
    for path in sorted(out_dir.glob("*.whl")):
        filename = path.name
        try:
            distribution, version_text = filename.split("-")[:2]
        except ValueError:
            continue
        if canonicalize_name(distribution.replace("_", "-")) != target_name:
            continue
        try:
            version = Version(version_text)
        except Exception:  # noqa: BLE001
            continue
        if specifier and not specifier.contains(version):
            continue
        return path
    return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--requirements", default="backend/requirements.txt")
    parser.add_argument("--out", default="wheelhouse")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    env = default_environment()
    env["extra"] = ""

    queue = load_requirements(Path(args.requirements))
    seen = set()
    errors = 0
    downloaded = 0
    while queue:
        requirement = queue.pop(0)
        name = requirement.name.lower()
        if name in seen:
            continue
        seen.add(name)
        print(f"resolve {requirement}", flush=True)
        existing = find_existing(out_dir, requirement, requirement.specifier)
        if existing is not None:
            print(f"  reuse {existing.name}", flush=True)
            path = existing
            if name != "rapidocr-onnxruntime":
                for dependency in wheel_metadata_requirements(path):
                    try:
                        dependent = Requirement(dependency)
                    except Exception:  # noqa: BLE001
                        continue
                    if dependent.marker is not None:
                        try:
                            if not dependent.marker.evaluate(env):
                                continue
                        except Exception:  # noqa: BLE001
                            continue
                    queue.append(dependent)
            continue
        try:
            data = fetch_index(name)
        except Exception as exc:  # noqa: BLE001
            print(f"  !! PyPI 查询失败 {name}: {exc}", flush=True)
            errors += 1
            continue
        version, item = pick_version(data, requirement.specifier)
        if item is None:
            print(f"  !! 找不到可用 wheel: {name} {requirement.specifier}", flush=True)
            errors += 1
            continue
        try:
            path = download_wheel(item, out_dir)
        except Exception as exc:  # noqa: BLE001
            print(f"  !! {exc}", flush=True)
            errors += 1
            continue
        downloaded += 1
        if name == "rapidocr-onnxruntime":
            continue
        for dependency in wheel_metadata_requirements(path):
            try:
                dependent = Requirement(dependency)
            except Exception:  # noqa: BLE001
                continue
            if dependent.marker is not None:
                try:
                    if not dependent.marker.evaluate(env):
                        continue
                except Exception:  # noqa: BLE001
                    continue
            queue.append(dependent)

    total = sum(f.stat().st_size for f in out_dir.glob("*.whl")) / 1048576
    print(f"完成：处理 {downloaded} 个包，错误 {errors} 个，目录 {out_dir.resolve()}（{total:.1f} MB）", flush=True)
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
