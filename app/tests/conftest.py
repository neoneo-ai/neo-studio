# SPDX-License-Identifier: Apache-2.0
"""桌面端用例单独跑时的数据根：分进程跑 app/tests 时根目录的 conftest 不在收集范围里，
plugin_paths 会顺着 configs/data_root.json 那份指针落到真实的 Neo-Studio/data ——
桌面端用例读写会话与配置就都落在用户数据里了。这里照根目录 conftest 同一口径钉一个临时根。
"""
import atexit
import os
import shutil
import tempfile

if not os.environ.get("NEO_STUDIO_DATA", "").strip():
    DATA_ROOT = tempfile.mkdtemp(prefix="neo_studio_desktop_test_data_")
    os.environ["NEO_STUDIO_DATA"] = str(DATA_ROOT)
    atexit.register(shutil.rmtree, DATA_ROOT, ignore_errors=True)