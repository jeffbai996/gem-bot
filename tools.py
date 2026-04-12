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
        
        # Remove script and style elements
        for script in soup(["script", "style"]):
            script.decompose()
            
        text = soup.get_text()
        
        # Break into lines and remove leading/trailing whitespace
        lines = (line.strip() for line in text.splitlines())
        # Break multi-headlines into a line each
        chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
        # Drop blank lines
        text = '\n'.join(chunk for chunk in chunks if chunk)
        
        return text[:5000] # Limit to first 5000 chars for context
    except Exception as e:
        return f"Error fetching {url}: {e}"

# Tool registry for Gemini Function Calling
TOOLS = {
    "get_current_time": get_current_time,
    "fetch_webpage": fetch_webpage
}

TOOL_DECLARATIONS = [
    {
        "name": "get_current_time",
        "description": "Returns the current local system date and time.",
        "parameters": {
            "type": "OBJECT",
            "properties": {}
        }
    },
    {
        "name": "fetch_webpage",
        "description": "Retrieves the text content of a website from a URL. Useful for reading news, documentation, or articles.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "url": {
                    "type": "STRING",
                    "description": "The full HTTP/HTTPS URL to fetch."
                }
            },
            "required": ["url"]
        }
    }
]