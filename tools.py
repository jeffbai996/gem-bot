import os
import subprocess
import datetime
import requests
from bs4 import BeautifulSoup

def get_current_time():
    """Returns the current system time."""
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def fetch_webpage(url: str):
    """Fetches the text content of a given URL."""
    try:
        headers = {'User-Agent': 'Mozilla/5.0'}
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        
        soup = BeautifulSoup(response.text, 'html.parser')
        for script in soup(["script", "style"]):
            script.decompose()
            
        text = soup.get_text()
        lines = (line.strip() for line in text.splitlines())
        chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
        text = '\n'.join(chunk for chunk in chunks if chunk)
        
        return text[:5000]
    except Exception as e:
        return f"Error fetching {url}: {e}"

def read_local_file(path: str):
    """Reads the content of a local file on the host machine."""
    # Expand ~ if present
    full_path = os.path.expanduser(path)
    try:
        with open(full_path, 'r') as f:
            return f.read(10000) # Limit to 10k chars
    except Exception as e:
        return f"Error reading file {path}: {e}"

def run_shell_command(command: str):
    """Executes a shell command on the host machine. (REQUIRES USER APPROVAL)"""
    try:
        # Run command with a timeout
        result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=30)
        output = result.stdout + result.stderr
        return output if output else "[Command executed with no output]"
    except Exception as e:
        return f"Error executing command: {e}"

# Tool registry
TOOLS = {
    "get_current_time": get_current_time,
    "fetch_webpage": fetch_webpage,
    "read_local_file": read_local_file,
    "run_shell_command": run_shell_command
}

# Sensitive tools that require explicit confirmation (✅ reaction)
SENSITIVE_TOOLS = ["run_shell_command", "read_local_file"]

TOOL_DECLARATIONS = [
    {
        "name": "get_current_time",
        "description": "Returns the current local system date and time.",
        "parameters": {"type": "OBJECT", "properties": {}}
    },
    {
        "name": "fetch_webpage",
        "description": "Retrieves the text content of a website from a URL.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "url": {"type": "STRING", "description": "The full URL to fetch."}
            },
            "required": ["url"]
        }
    },
    {
        "name": "read_local_file",
        "description": "Reads a file from the local filesystem. Useful for debugging or context gathering.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "path": {"type": "STRING", "description": "The absolute or relative path to the file."}
            },
            "required": ["path"]
        }
    },
    {
        "name": "run_shell_command",
        "description": "Executes a bash command. Use this for terminal-based tasks. VERY POWERFUL.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "command": {"type": "STRING", "description": "The shell command to run."}
            },
            "required": ["command"]
        }
    }
]