from __future__ import annotations

import argparse
import json
import sys
import subprocess
from pathlib import Path

from .compiler import build, compare, verify_build
from .evaluation import evaluate
from .extraction import extract
from .materials import ingest
from .project_check import project_check
from .storage import LabError, init_workspace, read_json
from .validation import validate_output


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description="双提示词本地工具：材料、规则、生成、验证；不执行交易")
    command.add_argument("--work", type=Path, default=Path(__file__).resolve().parents[1] / "work")
    sub = command.add_subparsers(dest="command", required=True)
    sub.add_parser("init", help="初始化私有工作目录").add_argument("--synthetic", action="store_true")
    add = sub.add_parser("ingest", help="只读导入一个明确指定的文件或目录")
    add.add_argument("--source", type=Path, required=True)
    add.add_argument("--channel", choices=("author", "system"), default="author")
    extraction = sub.add_parser("extract", help="调用配置的模型提取待审规则；需显式 --live")
    extraction.add_argument("--batch", required=True)
    extraction.add_argument("--live", action="store_true")
    compile_command = sub.add_parser("build", help="由完整、已审核规则生成双提示词")
    compile_command.add_argument("--rules", type=Path)
    compile_command.add_argument("--allow-synthetic", action="store_true")
    sub.add_parser("verify", help="校验不可变候选版文件").add_argument("--build", type=Path, required=True)
    check = sub.add_parser("check", help="检查一个输入输出对；不是服务器执行批准")
    check.add_argument("--role", choices=("analyst", "trader"), required=True)
    check.add_argument("--input", type=Path, required=True)
    check.add_argument("--output", type=Path, required=True)
    check.add_argument("--build", type=Path, required=True)
    evaluation = sub.add_parser("evaluate", help="运行离线返回检查或目标模型测试，保存全部结果")
    evaluation.add_argument("--build", type=Path, required=True)
    evaluation.add_argument("--cases", type=Path, required=True)
    mode = evaluation.add_mutually_exclusive_group(required=True)
    mode.add_argument("--responses", type=Path)
    mode.add_argument("--live", action="store_true")
    evaluation.add_argument("--repeats", type=int, default=1)
    sub.add_parser("project-check", help="用当前项目公开断言复核评测输出，不进行风控执行").add_argument("--report", type=Path, required=True)
    diff = sub.add_parser("diff", help="对比两个已生成版本")
    diff.add_argument("--before", type=Path, required=True)
    diff.add_argument("--after", type=Path, required=True)
    return command


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = parser().parse_args(argv)
    try:
        if args.command == "init":
            result = init_workspace(args.work, args.synthetic)
        elif args.command == "ingest":
            result = ingest(args.work, args.source, args.channel)
        elif args.command == "extract":
            result = extract(args.work, args.batch, live=args.live)
        elif args.command == "build":
            result = build(args.work, args.rules, allow_synthetic=args.allow_synthetic)
        elif args.command == "verify":
            result = verify_build(args.build)
        elif args.command == "check":
            manifest = verify_build(args.build)
            output = validate_output(args.role, args.output.read_text(encoding="utf-8-sig"), read_json(args.input),
                                     manifest["scope"]["max_analysis_validity_seconds"])
            result = {"status": "passed", "role": args.role, "result": output, "execution_authorized": False,
                      "project_runtime_validation": "not_tested"}
        elif args.command == "evaluate":
            result = evaluate(args.work, args.build, args.cases, live=args.live, responses_path=args.responses, repeats=args.repeats)
        elif args.command == "project-check":
            result = project_check(args.work, args.report)
        else:
            result = compare(args.before, args.after)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if result.get("failed", 0) else 0
    except LabError as error:
        print(json.dumps({"status": "failed", "code": error.code, "detail": error.detail}, ensure_ascii=False), file=sys.stderr)
        return 1
    except (OSError, UnicodeError) as error:
        print(json.dumps({"status": "failed", "code": "local_io_failed", "error_type": type(error).__name__}), file=sys.stderr)
        return 1
    except subprocess.TimeoutExpired:
        print(json.dumps({"status": "failed", "code": "project_contract_check_timeout"}), file=sys.stderr)
        return 1
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        print(json.dumps({"status": "failed", "code": "document_shape_invalid", "error_type": type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
