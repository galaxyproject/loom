#!/usr/bin/env python3
"""
Galaxy Tool & Workflow Checker - BioBlend-based automation for nf-to-galaxy conversions

This script provides THREE main capabilities:
1. Tool Availability Checking - Check if tools exist on Galaxy instance
2. Workflow Validation - Validate .ga files (check all tools are available)
3. Workflow Testing - Import and run workflows on Galaxy

Usage:

    TOOL CHECKING:
    # Check single tool
    python galaxy_tool_checker.py --url https://usegalaxy.org --api-key KEY --tool hyphy

    # Check multiple tools
    python galaxy_tool_checker.py --url https://usegalaxy.org --api-key KEY --tool hyphy iqtree seqkit

    # Check tools from file
    python galaxy_tool_checker.py --url https://usegalaxy.org --api-key KEY --tool-list tools.txt

    WORKFLOW VALIDATION:
    # Validate .ga workflow (check all tools exist)
    python galaxy_tool_checker.py --url https://usegalaxy.org --api-key KEY --workflow workflow.ga

    WORKFLOW TESTING:
    # Test workflow execution (import and run)
    python galaxy_tool_checker.py --url https://usegalaxy.org --api-key KEY --workflow workflow.ga --test --wait

    OUTPUT:
    # Save results to JSON
    python galaxy_tool_checker.py --url https://usegalaxy.org --api-key KEY --tool hyphy --output report.json
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Try to load .env file if it exists
try:
    from dotenv import load_dotenv
    # Look for .env in current directory and parent directories
    env_path = Path.cwd()
    while env_path != env_path.parent:
        env_file = env_path / ".env"
        if env_file.exists():
            load_dotenv(env_file)
            break
        env_path = env_path.parent
except ImportError:
    # python-dotenv not installed, skip .env loading
    pass

try:
    from bioblend.galaxy import GalaxyInstance
    from bioblend.galaxy.tools import ToolClient
except ImportError:
    print("Error: bioblend is not installed. Install with: pip install bioblend", file=sys.stderr)
    sys.exit(1)


class GalaxyToolChecker:
    """Check tool availability on a Galaxy instance"""

    def __init__(self, url: str, api_key: str):
        """
        Initialize Galaxy connection

        Args:
            url: Galaxy instance URL
            api_key: Galaxy API key
        """
        self.url = url if url.endswith('/') else f"{url}/"
        self.api_key = api_key
        self.gi = None
        self._connect()

    def _connect(self):
        """Establish connection to Galaxy"""
        try:
            self.gi = GalaxyInstance(url=self.url, key=self.api_key)
            # Test connection
            self.gi.users.get_current_user()
        except Exception as e:
            raise ConnectionError(f"Failed to connect to Galaxy at {self.url}: {e}")

    def search_tool(self, tool_name: str, exact: bool = False) -> List[Dict[str, Any]]:
        """
        Search for a tool by name

        Args:
            tool_name: Tool name to search for
            exact: If True, only return exact matches

        Returns:
            List of matching tools with id, name, version
        """
        try:
            # Get all tools
            tools = self.gi.tools.get_tools()

            # Filter by name
            matches = []
            tool_name_lower = tool_name.lower()

            for tool in tools:
                tool_id = tool.get('id', '')
                tool_display_name = tool.get('name', '')

                # Skip tool labels
                if tool_id.endswith('_label'):
                    continue

                # Check for match
                if exact:
                    if tool_display_name.lower() == tool_name_lower or tool_name_lower in tool_id.lower():
                        matches.append(tool)
                else:
                    if tool_name_lower in tool_display_name.lower() or tool_name_lower in tool_id.lower():
                        matches.append(tool)

            return matches

        except Exception as e:
            raise RuntimeError(f"Failed to search for tool '{tool_name}': {e}")

    def get_tool_details(self, tool_id: str) -> Dict[str, Any]:
        """
        Get detailed information about a tool

        Args:
            tool_id: Galaxy tool ID

        Returns:
            Tool details including inputs, outputs, version
        """
        try:
            return self.gi.tools.show_tool(tool_id, io_details=True)
        except Exception as e:
            raise RuntimeError(f"Failed to get details for tool '{tool_id}': {e}")

    def check_tools_batch(self, tool_names: List[str]) -> Dict[str, Any]:
        """
        Check multiple tools at once

        Args:
            tool_names: List of tool names to check

        Returns:
            Dictionary with results for each tool
        """
        results = {
            "galaxy_url": self.url,
            "checked_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
            "tools": {}
        }

        for tool_name in tool_names:
            try:
                matches = self.search_tool(tool_name)
                results["tools"][tool_name] = {
                    "found": len(matches) > 0,
                    "match_count": len(matches),
                    "matches": [
                        {
                            "id": t.get("id"),
                            "name": t.get("name"),
                            "version": t.get("version"),
                            "description": t.get("description", "")[:100]  # Truncate
                        }
                        for t in matches[:5]  # Limit to top 5 matches
                    ]
                }
            except Exception as e:
                results["tools"][tool_name] = {
                    "found": False,
                    "error": str(e)
                }

        # Add summary
        found_count = sum(1 for t in results["tools"].values() if t.get("found", False))
        results["summary"] = {
            "total_tools": len(tool_names),
            "found": found_count,
            "not_found": len(tool_names) - found_count,
            "success_rate": f"{(found_count / len(tool_names) * 100):.1f}%" if tool_names else "0%"
        }

        return results

    def validate_workflow(self, workflow_path: str) -> Dict[str, Any]:
        """
        Validate a Galaxy workflow file (.ga) by checking all tools exist

        Args:
            workflow_path: Path to .ga workflow file

        Returns:
            Validation results
        """
        try:
            with open(workflow_path, 'r') as f:
                workflow = json.load(f)
        except Exception as e:
            raise ValueError(f"Failed to load workflow file: {e}")

        results = {
            "workflow_name": workflow.get("name", "Unknown"),
            "workflow_file": workflow_path,
            "galaxy_url": self.url,
            "steps": {},
            "tools_checked": set(),
            "validation": {
                "valid": True,
                "errors": [],
                "warnings": []
            }
        }

        # Check each step
        steps = workflow.get("steps", {})
        for step_id, step in steps.items():
            step_type = step.get("type")
            tool_id = step.get("tool_id")

            if step_type == "tool" and tool_id:
                results["tools_checked"].add(tool_id)

                try:
                    # Try to get tool details
                    tool_details = self.get_tool_details(tool_id)
                    results["steps"][step_id] = {
                        "name": step.get("name", "Unknown"),
                        "tool_id": tool_id,
                        "status": "ok",
                        "tool_name": tool_details.get("name"),
                        "tool_version": tool_details.get("version")
                    }
                except Exception as e:
                    results["steps"][step_id] = {
                        "name": step.get("name", "Unknown"),
                        "tool_id": tool_id,
                        "status": "error",
                        "error": str(e)
                    }
                    results["validation"]["valid"] = False
                    results["validation"]["errors"].append(
                        f"Step {step_id} ({step.get('name')}): Tool '{tool_id}' not found or not accessible"
                    )

        results["tools_checked"] = list(results["tools_checked"])
        results["validation"]["total_steps"] = len(steps)
        results["validation"]["tool_steps"] = len([s for s in steps.values() if s.get("type") == "tool"])
        results["validation"]["valid_tools"] = len([s for s in results["steps"].values() if s.get("status") == "ok"])

        return results

    def test_workflow(self, workflow_path: str, history_name: Optional[str] = None,
                     inputs: Optional[Dict[str, str]] = None, wait: bool = False) -> Dict[str, Any]:
        """
        Test a workflow by importing and optionally running it

        Args:
            workflow_path: Path to .ga workflow file
            history_name: Name for test history (optional)
            inputs: Input dataset mappings (optional)
            wait: Wait for workflow completion (optional)

        Returns:
            Test results
        """
        # First validate the workflow
        validation = self.validate_workflow(workflow_path)

        if not validation["validation"]["valid"]:
            return {
                "success": False,
                "message": "Workflow validation failed",
                "validation": validation
            }

        # Import workflow
        try:
            with open(workflow_path, 'r') as f:
                workflow_dict = json.load(f)

            imported = self.gi.workflows.import_workflow_dict(workflow_dict)
            workflow_id = imported["id"]

            result = {
                "success": True,
                "message": "Workflow imported successfully",
                "workflow_id": workflow_id,
                "workflow_name": imported.get("name"),
                "validation": validation
            }

            # If inputs provided, try to run it
            if inputs and history_name:
                history = self.gi.histories.create_history(history_name)
                history_id = history["id"]

                invocation = self.gi.workflows.invoke_workflow(
                    workflow_id=workflow_id,
                    inputs=inputs,
                    history_id=history_id
                )

                result["invocation"] = {
                    "id": invocation.get("id"),
                    "history_id": history_id,
                    "state": invocation.get("state")
                }

                # Wait for completion if requested
                if wait:
                    result["invocation"]["final_state"] = self._wait_for_workflow(
                        invocation.get("id"),
                        timeout=3600
                    )

            return result

        except Exception as e:
            return {
                "success": False,
                "message": f"Failed to test workflow: {e}",
                "validation": validation
            }

    def _wait_for_workflow(self, invocation_id: str, timeout: int = 3600) -> str:
        """Wait for workflow invocation to complete"""
        start_time = time.time()
        while time.time() - start_time < timeout:
            try:
                invocation = self.gi.invocations.show_invocation(invocation_id)
                state = invocation.get("state")
                if state in ["scheduled", "ok", "error", "failed"]:
                    return state
                time.sleep(10)
            except Exception:
                break
        return "timeout"


def main():
    parser = argparse.ArgumentParser(
        description="Check Galaxy tool availability for nf-to-galaxy conversions",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )

    # Connection arguments
    parser.add_argument("--url", help="Galaxy instance URL (or set GALAXY_URL env var)")
    parser.add_argument("--api-key", help="Galaxy API key (or set GALAXY_API_KEY env var)")

    # Tool checking arguments
    parser.add_argument("--tool", nargs="+", help="Tool name(s) to check")
    parser.add_argument("--tool-list", type=Path, help="File containing tool names (one per line)")
    parser.add_argument("--exact", action="store_true", help="Require exact name matches")

    # Workflow testing arguments
    parser.add_argument("--workflow", type=Path, help="Workflow file (.ga) to validate/test")
    parser.add_argument("--test", action="store_true", help="Actually test workflow (import and run)")
    parser.add_argument("--history", help="History name for workflow test")
    parser.add_argument("--wait", action="store_true", help="Wait for workflow completion")

    # Output arguments
    parser.add_argument("--output", type=Path, help="Output file for JSON results")
    parser.add_argument("--verbose", action="store_true", help="Verbose output")
    parser.add_argument("--quiet", action="store_true", help="Minimal output")

    args = parser.parse_args()

    # Get URL and API key from args or environment
    url = args.url or os.environ.get("GALAXY_URL")
    api_key = args.api_key or os.environ.get("GALAXY_API_KEY")

    # Check for missing credentials
    if not url:
        print("Error: Galaxy URL required", file=sys.stderr)
        print("  Provide via: --url https://usegalaxy.org", file=sys.stderr)
        print("  Or set: GALAXY_URL environment variable", file=sys.stderr)
        print("  Or create: .env file with GALAXY_URL=https://usegalaxy.org/", file=sys.stderr)
        sys.exit(1)

    if not api_key:
        print("Error: Galaxy API key required", file=sys.stderr)
        print("  Provide via: --api-key YOUR_KEY", file=sys.stderr)
        print("  Or set: GALAXY_API_KEY environment variable", file=sys.stderr)
        print("  Or create: .env file with GALAXY_API_KEY=your_key", file=sys.stderr)
        print("", file=sys.stderr)
        print("  Get your API key from Galaxy:", file=sys.stderr)
        print(f"  {url}user/api_key" if url else "  https://usegalaxy.org/user/api_key", file=sys.stderr)
        sys.exit(1)

    # Initialize checker
    try:
        checker = GalaxyToolChecker(url, api_key)
        if args.verbose:
            print(f"Connected to Galaxy at {url}")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    results = None

    # Check tools
    if args.tool or args.tool_list:
        tool_names = args.tool or []

        if args.tool_list:
            try:
                with open(args.tool_list, 'r') as f:
                    tool_names.extend([line.strip() for line in f if line.strip()])
            except Exception as e:
                print(f"Error reading tool list: {e}", file=sys.stderr)
                sys.exit(1)

        if not tool_names:
            print("Error: No tools specified", file=sys.stderr)
            sys.exit(1)

        results = checker.check_tools_batch(tool_names)

        if not args.quiet:
            print(f"\n{'='*60}")
            print(f"Tool Availability Report")
            print(f"Galaxy: {args.url}")
            print(f"{'='*60}\n")

            for tool_name, result in results["tools"].items():
                if result.get("found"):
                    print(f"✅ {tool_name}: Found {result['match_count']} match(es)")
                    if args.verbose and result.get("matches"):
                        for match in result["matches"]:
                            print(f"   - {match['name']} ({match['version']})")
                            print(f"     ID: {match['id']}")
                else:
                    print(f"❌ {tool_name}: Not found")
                    if result.get("error"):
                        print(f"   Error: {result['error']}")

            print(f"\n{'='*60}")
            print(f"Summary: {results['summary']['found']}/{results['summary']['total_tools']} tools found "
                  f"({results['summary']['success_rate']})")
            print(f"{'='*60}\n")

    # Validate/test workflow
    elif args.workflow:
        if args.test:
            results = checker.test_workflow(
                str(args.workflow),
                history_name=args.history,
                wait=args.wait
            )
        else:
            results = checker.validate_workflow(str(args.workflow))

        if not args.quiet:
            print(f"\n{'='*60}")
            print(f"Workflow Validation Report")
            print(f"Workflow: {results.get('workflow_name', 'Unknown')}")
            print(f"Galaxy: {args.url}")
            print(f"{'='*60}\n")

            validation = results.get("validation", {})
            if validation.get("valid"):
                print(f"✅ Workflow is valid")
                print(f"   - {validation.get('valid_tools', 0)}/{validation.get('tool_steps', 0)} tools available")
            else:
                print(f"❌ Workflow validation failed")
                for error in validation.get("errors", []):
                    print(f"   - {error}")

            if args.test and results.get("success"):
                print(f"\n✅ Workflow imported successfully")
                print(f"   Workflow ID: {results.get('workflow_id')}")
                if results.get("invocation"):
                    inv = results["invocation"]
                    print(f"   Invocation ID: {inv.get('id')}")
                    print(f"   History ID: {inv.get('history_id')}")
                    if inv.get("final_state"):
                        print(f"   Final state: {inv.get('final_state')}")

            print(f"\n{'='*60}\n")

    else:
        print("Error: Must specify --tool, --tool-list, or --workflow", file=sys.stderr)
        parser.print_help()
        sys.exit(1)

    # Output JSON if requested
    if args.output and results:
        try:
            with open(args.output, 'w') as f:
                json.dump(results, f, indent=2)
            if not args.quiet:
                print(f"Results written to {args.output}")
        except Exception as e:
            print(f"Error writing output: {e}", file=sys.stderr)
            sys.exit(1)

    # Exit with appropriate code
    if results:
        if "validation" in results:
            sys.exit(0 if results["validation"].get("valid", False) else 1)
        elif "summary" in results:
            sys.exit(0 if results["summary"]["found"] == results["summary"]["total_tools"] else 1)
        elif "success" in results:
            sys.exit(0 if results["success"] else 1)

    sys.exit(0)


if __name__ == "__main__":
    main()
