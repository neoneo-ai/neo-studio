# SPDX-License-Identifier: Apache-2.0
"""分层规则文件的一致性校验：根 AGENTS.md 与各目录级 AGENTS.md 指针对得上。

规则按领域下沉到目录级 AGENTS.md 之后，最容易坏的是两件事：新加一层没人知道（根文件的
Area Rules 表与 Repository Map 没有它），以及把根规则又抄一份到嵌套文件里（同一规则出现
三处时改一处就留下两处旧文本）。这里逐条钉住：根文件必须列全仓库里存在的每个 AGENTS.md，
每个嵌套文件必须指回根文件，根文件不得再留已下沉那几节的标题。
"""
import os
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ROOT_RULES = REPO / "AGENTS.md"
AREA_RULES_FILES = (
    "studio/AGENTS.md",
    "studio/web/AGENTS.md",
    "app/AGENTS.md",
    "tools/AGENTS.md",
)
# 已经下沉的节；根文件里再出现同名标题就说明有人把规则抄回来了
MOVED_HEADINGS = (
    "## Node Contract",
    "## Python Style",
    "## Frontend Style",
    "## Desktop App",
)
SKIP_DIRS = {".git", "node_modules", "tmp", "build", "data", "custom_nodes", "dist"}
# 布局文档里插件文件清单那一节的标题，两份镜像各按自己的语言钉住
PLUGIN_TREE_HEADING = {
    "docs/architecture.md": "## 内核插件文件",
    "docs/en/architecture.md": "## Kernel plugin files",
}


def _repo_agent_files():
    """仓库里的 AGENTS.md 相对路径，含根文件；依赖与产物目录整棵跳过。"""
    found = set()
    for dirpath, dirnames, filenames in os.walk(REPO):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        if "AGENTS.md" in filenames:
            found.add(Path(dirpath).relative_to(REPO).joinpath("AGENTS.md").as_posix())
    return found


def _tree_entry_names(block):
    """仓库树每行的条目名：方框符号之后的第一个词就是文件名，说明文字在它之后。"""
    names = []
    for line in block.splitlines():
        tokens = line.split()
        marks = [i for i, token in enumerate(tokens) if set(token) <= set("├└│─")]
        if marks and marks[-1] + 1 < len(tokens):
            names.append(tokens[marks[-1] + 1])
    return names


class TestAgentDocs(unittest.TestCase):

    def setUp(self):
        self.root_text = ROOT_RULES.read_text(encoding="utf-8")

    def test_area_rules_lists_every_agent_file(self):
        """新增一层 AGENTS.md 而没写进根文件指针，节点与规则的读者就找不到它。"""
        rows = [line.split("|")[1].strip() for line in self.root_text.splitlines()
                if line.startswith("| [")]
        links = {cell.split("](")[1].rstrip(")") for cell in rows}
        self.assertEqual(_repo_agent_files() - {"AGENTS.md"}, links)

    def test_nested_files_point_back_to_root(self):
        for rel in AREA_RULES_FILES:
            with self.subTest(rel):
                text = (REPO / rel).read_text(encoding="utf-8")
                root_link = "](../AGENTS.md)" if rel.count("/") == 1 else "](../../AGENTS.md)"
                self.assertIn(root_link, text)

    def test_root_no_longer_carries_moved_sections(self):
        for heading in MOVED_HEADINGS:
            with self.subTest(heading):
                self.assertNotIn(heading, self.root_text)

    def test_layout_docs_carry_the_repo_tree(self):
        """根文件不画树：仓库布局的权威树在 docs/architecture.md 与它的英文镜像里，五处 AGENTS.md 都要在图上。"""
        for rel in ("docs/architecture.md", "docs/en/architecture.md"):
            with self.subTest(rel):
                text = (REPO / rel).read_text(encoding="utf-8")
                trees = [block for block in text.split("```") if block.lstrip("\n").startswith("Neo-Studio/")]
                self.assertEqual(len(trees), 1)
                self.assertEqual(_tree_entry_names(trees[0]).count("AGENTS.md"),
                                 len(AREA_RULES_FILES) + 1)
                self.assertIn(PLUGIN_TREE_HEADING[rel], text)

    def test_claude_pointer_names_root_rules(self):
        """CLAUDE.md 只当指针；写成第二份规则就会和 AGENTS.md 漂移。"""
        pointer = (REPO / "CLAUDE.md").read_text(encoding="utf-8")
        self.assertIn("[AGENTS.md](AGENTS.md)", pointer)
        for heading in MOVED_HEADINGS:
            self.assertNotIn(heading, pointer)


if __name__ == "__main__":
    unittest.main()
