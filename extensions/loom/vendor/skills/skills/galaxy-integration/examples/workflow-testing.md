# Workflow Testing with Galaxy MCP and BioBlend

Generic guide for testing and validating workflows on Galaxy instances.

---

## Overview

After creating a Galaxy workflow, test it on a Galaxy instance to verify functionality. This guide covers two methods: interactive (Galaxy MCP) and automated (BioBlend script).

---

## Method 1: Interactive Workflow Testing with Galaxy MCP

### When to Use

- First-time workflow testing
- Debugging workflow issues
- Need real-time monitoring
- Complex workflows requiring iteration

### Step 1: Connect to Galaxy

```python
# Check connection
get_server_info()

# Connect if needed
connect(url="https://usegalaxy.org", api_key="YOUR_API_KEY")
```

### Step 2: Import Workflow

```python
# Import workflow from file
workflow = import_workflow(path="my_workflow.ga")

# Returns workflow ID and details
# Note: This validates that all tools exist
```

**If import fails**:
- Check tool availability (see `tool-checking.md`)
- Verify workflow JSON structure
- Check for missing tool versions

### Step 3: Create Test History

```python
# Create new history for testing
history = create_history(name="Test: My Workflow")

# Get history ID for later use
history_id = history["id"]
```

### Step 4: Upload Test Data

```python
# Upload test input file
upload_result = upload_file(
    history_id=history_id,
    path="test_data/input.fasta",
    file_type="fasta"
)

# Get dataset ID
input_dataset_id = upload_result["outputs"][0]["id"]
```

### Step 5: Invoke Workflow

```python
# Invoke workflow with inputs
invocation = invoke_workflow(
    workflow_id=workflow["id"],
    history_id=history_id,
    inputs={
        "0": {"id": input_dataset_id, "src": "hda"}
    },
    parameters={}
)

# Returns invocation ID
invocation_id = invocation["id"]
```

**Input mapping**:
- `"0"` = workflow step number (input step)
- `"id"` = dataset ID from upload
- `"src"` = source type ("hda" = history dataset)

### Step 6: Monitor Execution

```python
# Check invocation status
status = get_invocation(
    workflow_id=workflow["id"],
    invocation_id=invocation_id
)

# Check state: "new", "ready", "scheduled", "running", "ok", "error"
print(f"State: {status['state']}")

# Monitor until complete
while status["state"] in ["new", "ready", "scheduled", "running"]:
    time.sleep(10)
    status = get_invocation(workflow_id=workflow["id"], invocation_id=invocation_id)
    print(f"State: {status['state']}")
```

### Step 7: Check Results

```python
# Get history contents
contents = get_history_contents(
    history_id=history_id,
    order="create_time-dsc",
    limit=10
)

# Check for errors
errors = [d for d in contents if d["state"] == "error"]
if errors:
    print(f"❌ {len(errors)} datasets failed")
    for dataset in errors:
        print(f"  - {dataset['name']}: {dataset.get('misc_info', 'Unknown error')}")
else:
    print("✅ All datasets completed successfully")
```

### Step 8: Verify Outputs

```python
# Download output for inspection
output_dataset = [d for d in contents if d["name"] == "Expected Output"][0]

# Get dataset details
details = get_dataset_details(
    history_id=history_id,
    dataset_id=output_dataset["id"]
)

# Verify:
# - Correct file type
# - Expected size range
# - No error messages
```

---

## Method 2: Automated Workflow Testing with BioBlend Script

### When to Use

- Automated validation
- CI/CD integration
- Batch testing multiple workflows
- Quick validation checks

### Step 1: Validate Workflow Structure

```bash
# Check workflow without running
python ../scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key $GALAXY_API_KEY \
    --workflow my_workflow.ga \
    --verbose
```

**Output**:
```
============================================================
Workflow Validation Report
Workflow: My Workflow
Galaxy: https://usegalaxy.org
============================================================

Workflow is valid
   - 5/5 tools available

Step 0: Input Dataset
  Type: data_input

Step 1: Quality Filter
  Tool: toolshed.g2.bx.psu.edu/repos/iuc/fastqc/fastqc/0.12.1+galaxy0
  Status: ✅

Step 2: Alignment
  Tool: toolshed.g2.bx.psu.edu/repos/iuc/bwa_mem/bwa_mem/0.7.17+galaxy1
  Status: ✅

[...]

============================================================
```

### Step 2: Test Workflow Execution

```bash
# Import and optionally run workflow
python ../scripts/galaxy_tool_checker.py \
    --url https://usegalaxy.org \
    --api-key $GALAXY_API_KEY \
    --workflow my_workflow.ga \
    --test \
    --history "Test: My Workflow" \
    --wait
```

**Flags**:
- `--test` - Actually import and invoke workflow
- `--history` - Create history with this name
- `--wait` - Wait for workflow completion

**Output**:
```
============================================================
Workflow Test Report
Workflow: My Workflow
Galaxy: https://usegalaxy.org
============================================================

Workflow is valid
   - 5/5 tools available

Workflow imported successfully
   Workflow ID: wf_abc123
   
Workflow invoked
   Invocation ID: inv_def456
   History ID: hist_789xyz
   
Waiting for completion...
   State: scheduled
   State: running
   State: ok
   
Final state: ok ✅

============================================================
```

### Step 3: Parse Results Programmatically

```python
import json
import subprocess

# Run validation
result = subprocess.run([
    "python", "../scripts/galaxy_tool_checker.py",
    "--url", "https://usegalaxy.org",
    "--api-key", api_key,
    "--workflow", "my_workflow.ga",
    "--output", "validation.json"
], capture_output=True)

# Check exit code
if result.returncode == 0:
    print("✅ Workflow is valid")
else:
    print("❌ Workflow validation failed")
    
# Parse results
with open("validation.json", "r") as f:
    validation = json.load(f)
    
# Check each step
for step_id, step_info in validation["steps"].items():
    if step_info["status"] != "ok":
        print(f"Problem in step {step_id}: {step_info['error']}")
```

---

## Decision Matrix: MCP vs BioBlend Script

| Aspect | Galaxy MCP | BioBlend Script |
|--------|-----------|-----------------|
| **Validation** | Interactive, step-by-step | Automated, batch |
| **Execution** | Manual invocation | Can automate with --test |
| **Monitoring** | Real-time queries | Polling or --wait flag |
| **Debugging** | Interactive exploration | Log-based |
| **Iteration** | Agent-driven | Script-driven |
| **Best For** | Complex debugging | CI/CD, batch testing |
| **Token usage** | Higher | Lower |

---

## Common Workflows

### Workflow 1: Initial Testing

```
1. Validate workflow structure (BioBlend script)
   └─ Verify all tools exist
   
2. Import workflow (MCP)
   └─ Check for import errors
   
3. Test with minimal data (MCP)
   └─ Quick validation
   
4. Iterate on failures (MCP)
   └─ Debug interactively
```

### Workflow 2: Automated Testing

```
1. Validate structure (BioBlend script)
   └─ --workflow file.ga
   
2. Test execution (BioBlend script)
   └─ --workflow file.ga --test --wait
   
3. Parse results (Python)
   └─ Check exit code and JSON output
```

### Workflow 3: Iterative Development

```
1. Create workflow
2. Test with MCP (interactive)
3. Fix issues
4. Repeat until working
5. Final validation with BioBlend script
6. Commit workflow
```

---

## Automated Iteration Pattern

For complex workflows requiring multiple iterations:

```python
def test_workflow_iteratively(workflow_path, max_iterations=5):
    """Test workflow and fix issues automatically"""
    
    for iteration in range(max_iterations):
        print(f"\n=== Iteration {iteration + 1} ===")
        
        # 1. Import workflow
        workflow = import_workflow(path=workflow_path)
        
        # 2. Create test history
        history = create_history(name=f"Test iteration {iteration + 1}")
        
        # 3. Upload test data
        upload_result = upload_file(
            history_id=history["id"],
            path="test_data/input.fasta",
            file_type="fasta"
        )
        
        # 4. Invoke workflow
        invocation = invoke_workflow(
            workflow_id=workflow["id"],
            history_id=history["id"],
            inputs={"0": {"id": upload_result["outputs"][0]["id"], "src": "hda"}}
        )
        
        # 5. Wait for completion
        status = wait_for_invocation(workflow["id"], invocation["id"])
        
        # 6. Check results
        contents = get_history_contents(history["id"])
        
        errors = [d for d in contents if d["state"] == "error"]
        if not errors:
            print("✅ Workflow executed successfully!")
            return True
        
        # 7. Analyze and fix errors
        print(f"❌ Found {len(errors)} errors")
        for dataset in errors:
            fix_dataset_error(workflow_path, dataset)
    
    return False
```

---

## Troubleshooting

### Workflow Import Fails

**Causes**:
- Tool not available on Galaxy instance
- Invalid workflow JSON structure
- Tool version mismatch

**Solutions**:
```python
# Check tool availability first
python ../scripts/galaxy_tool_checker.py \
    --workflow my_workflow.ga \
    --url https://usegalaxy.org

# Validate JSON structure
import json
with open("my_workflow.ga") as f:
    workflow = json.load(f)
    # Check for required fields
```

### Workflow Execution Fails

**Causes**:
- Invalid input data
- Tool parameter errors
- Resource limitations

**Solutions**:
```python
# Check dataset states
contents = get_history_contents(history_id=history_id)
for dataset in contents:
    if dataset["state"] == "error":
        # Get error details
        details = get_dataset_details(history_id, dataset["id"])
        print(f"Error: {details.get('misc_info', 'Unknown')}")
```

### Workflow Hangs

**Causes**:
- Long-running job
- Queue delays
- Resource allocation issues

**Solutions**:
```python
# Check invocation state
status = get_invocation(workflow_id, invocation_id)
print(f"State: {status['state']}")

# Check individual job states
for step in status["steps"]:
    print(f"Step {step['order_index']}: {step['state']}")
```

---

## Output Comparison

### Comparing Workflow Outputs

```python
def compare_outputs(history_id, expected_patterns):
    """Compare workflow outputs against expected patterns"""
    
    contents = get_history_contents(history_id=history_id)
    
    results = {}
    for pattern_name, pattern in expected_patterns.items():
        matching = [d for d in contents if pattern in d["name"]]
        results[pattern_name] = {
            "found": len(matching) > 0,
            "count": len(matching),
            "datasets": matching
        }
    
    return results

# Usage
expected = {
    "alignment": "aligned",
    "statistics": "stats",
    "filtered": "filtered"
}

results = compare_outputs(history_id, expected)
for name, result in results.items():
    if result["found"]:
        print(f"✅ {name}: {result['count']} dataset(s)")
    else:
        print(f"❌ {name}: not found")
```

---

## Best Practices

### Pre-Test Checklist

- [ ] All tools validated with tool checker
- [ ] Test data prepared or identified
- [ ] Test history created
- [ ] Workflow imported to Galaxy

### During Testing

1. **Start simple** - Test with minimal input first
2. **Check each step** - Don't wait for full workflow to fail
3. **Monitor states** - Use `get_history_contents` frequently
4. **Document issues** - Keep track of what you fix

### Post-Test

1. **Verify outputs** - Check file formats and content
2. **Clean up** - Delete test histories if not needed
3. **Document tool IDs** - Record exact versions used
4. **Update workflow** - Commit working `.ga` file

---

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Test Galaxy Workflow

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      
      - name: Install dependencies
        run: |
          pip install bioblend
          
      - name: Validate workflow
        env:
          GALAXY_API_KEY: ${{ secrets.GALAXY_API_KEY }}
        run: |
          python galaxy_tool_checker.py \
            --url https://usegalaxy.org \
            --workflow workflow.ga \
            --output validation.json
            
      - name: Upload results
        uses: actions/upload-artifact@v2
        with:
          name: validation-results
          path: validation.json
```

---

## Related Documentation

- **Main guide**: `../galaxy-integration.md` - Complete Galaxy integration guide
- **Tool checking**: `tool-checking.md` - Verify tool availability
- **BioBlend script**: `../scripts/README.md` - galaxy_tool_checker.py usage
- **Planemo testing**: `../../../dev-skills/tool-dev/references/testing.md` - Tool-level testing

---

## Common Issues and Fixes

### Issue 1: Tool Not Found

**Symptom**: `Tool 'xyz' not found`

**Fix**:
```python
# Find correct tool ID
tools = search_tools_by_name(query="xyz")
# Update .ga file with correct tool_id
```

### Issue 2: Datatype Mismatch

**Symptom**: `Incompatible datatype: expected fasta, got txt`

**Fix**:
```python
# Check tool requirements
details = get_tool_details(tool_id="...", io_details=True)
# Update workflow connection or add format conversion step
```

### Issue 3: Missing Parameters

**Symptom**: `Required parameter 'threads' not provided`

**Fix**:
```json
{
  "tool_state": {
    "threads": "4"
  }
}
```

### Issue 4: Input Mapping Error

**Symptom**: `Input step 0 not found`

**Fix**:
```python
# Check workflow input steps
# Ensure input mapping matches step indices in .ga file
inputs = {
    "0": {"id": "dataset_id", "src": "hda"}  # Step index must match
}
```

---

## Next Steps

After successful testing:

1. **Document the workflow** - Add description, annotations
2. **Create test data** - Package example inputs
3. **Share workflow** - Export to IWC or local repository
4. **Integrate with pipeline** - Connect to other workflows if needed
