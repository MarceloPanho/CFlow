"""tree-sitter C++ parsing. No CFG logic here — just the syntax tree."""

from __future__ import annotations

from dataclasses import dataclass

from tree_sitter import Language, Node, Parser, Tree
import tree_sitter_cpp


_PARSER: Parser | None = None


def _parser() -> Parser:
    global _PARSER
    if _PARSER is None:
        _PARSER = Parser(Language(tree_sitter_cpp.language()))
    return _PARSER


def parse_cpp(source: str) -> Tree:
    return _parser().parse(source.encode("utf-8"))


def node_text(source: str | bytes, node: Node) -> str:
    raw = source.encode("utf-8") if isinstance(source, str) else source
    return raw[node.start_byte : node.end_byte].decode("utf-8")


def node_lines(node: Node) -> list[int]:
    start = node.start_point[0] + 1
    end = node.end_point[0] + 1
    return list(range(start, end + 1))


def _declarator_identifier(node: Node, source: str) -> str | None:
    if node.type == "identifier":
        return node_text(source, node)
    field = node.child_by_field_name("declarator")
    if field is not None:
        found = _declarator_identifier(field, source)
        if found:
            return found
    for child in node.children:
        found = _declarator_identifier(child, source)
        if found:
            return found
    return None


@dataclass
class FunctionInfo:
    name: str
    node: Node
    start_line: int
    end_line: int


def list_functions(tree: Tree, source: str) -> list[FunctionInfo]:
    out: list[FunctionInfo] = []

    def walk(node: Node) -> None:
        if node.type == "function_definition":
            decl = node.child_by_field_name("declarator")
            name = _declarator_identifier(decl, source) if decl is not None else None
            if name:
                out.append(
                    FunctionInfo(
                        name=name,
                        node=node,
                        start_line=node.start_point[0] + 1,
                        end_line=node.end_point[0] + 1,
                    )
                )
            return
        for child in node.children:
            walk(child)

    walk(tree.root_node)
    return out


def subscript_indices(source: str) -> dict[str, dict[str, list[str]]]:
    """Per function, the non-constant index expressions used on each array.

    {"bubbleSort": {"arr": ["j", "j + 1"]}} -- the tracer evaluates them per step.
    """
    tree = parse_cpp(source)
    out: dict[str, dict[str, list[str]]] = {}

    def has_identifier(node: Node) -> bool:
        return node.type == "identifier" or any(has_identifier(c) for c in node.children)

    for fn in list_functions(tree, source):
        found: dict[str, list[str]] = {}

        def walk(node: Node) -> None:
            if node.type == "subscript_expression":
                arg = node.child_by_field_name("argument")
                idx = node.child_by_field_name("indices")
                if arg is not None and arg.type == "identifier" and idx is not None and idx.named_children:
                    expr = " ".join(node_text(source, idx.named_children[0]).split())
                    exprs = found.setdefault(node_text(source, arg), [])
                    if has_identifier(idx) and expr not in exprs:
                        exprs.append(expr)
            for child in node.children:
                walk(child)

        walk(fn.node)
        out[fn.name] = {k: v for k, v in found.items() if v}
    return out
