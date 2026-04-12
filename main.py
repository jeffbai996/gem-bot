import os
import discord
import asyncio
import mimetypes
from dotenv import load_dotenv
from google import genai
from google.genai import types
from tools import TOOLS, TOOL_DECLARATIONS, SENSITIVE_TOOLS

# Load environment variables
load_dotenv()

DISCORD_TOKEN = os.getenv("DISCORD_TOKEN")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# ALLOWED_USERS: List of Discord User IDs permitted to use the bot
# Jeff's IDs from shared-context: REDACTED_USER_ID
ALLOWED_USERS = [int(id) for id in os.getenv("ALLOWED_USERS", "REDACTED_USER_ID").split(",")]

if not DISCORD_TOKEN or not GEMINI_API_KEY:
    print("Error: DISCORD_TOKEN and GEMINI_API_KEY must be set in .env")
    exit(1)

# Initialize Gemini Client
client = genai.Client(api_key=GEMINI_API_KEY)
MODEL_ID = "gemini-2.0-flash-exp" # Or gemini-2.5-flash

# Set up Discord intents
intents = discord.Intents.default()
intents.message_content = True  # Required to read message content

class GeminiBot(discord.Client):
    async def on_ready(self):
        activity = discord.Activity(type=discord.ActivityType.listening, name="your requests")
        await self.change_presence(status=discord.Status.online, activity=activity)
        print(f'Logged in as {self.user} (ID: {self.user.id})')
        print(f'Allowed Users: {ALLOWED_USERS}')
        print('------')

    async def on_message(self, message):
        if message.author == self.user:
            return

        # Security check: User Allowlist
        if message.author.id not in ALLOWED_USERS:
            return

        is_in_thread = isinstance(message.channel, discord.Thread)
        bot_mentioned = self.user in message.mentions

        if not is_in_thread and bot_mentioned:
            thread_name = f"Chat with {message.author.display_name}"
            thread = await message.create_thread(name=thread_name, auto_archive_duration=60)
            await self.process_gemini_request(thread, message)
            return

        if is_in_thread and (message.channel.owner_id == self.user.id or bot_mentioned):
            await self.process_gemini_request(message.channel, message)

    async def process_gemini_request(self, channel, trigger_message):
        """Main loop for generating content, handling attachments and tool calls."""
        try:
            await trigger_message.add_reaction("⏳")
        except: pass

        async with channel.typing():
            try:
                history = []
                async for msg in channel.history(limit=30, oldest_first=True):
                    role = "model" if msg.author == self.user else "user"
                    parts = []
                    
                    clean_text = msg.clean_content.replace(f'@{self.user.display_name}', '').strip()
                    if clean_text:
                        parts.append({"text": clean_text})
                    
                    for att in msg.attachments:
                        mime_type = att.content_type or mimetypes.guess_type(att.url)[0]
                        if mime_type and (mime_type.startswith("image/") or mime_type.startswith("text/")):
                            data = await att.read()
                            parts.append({"inline_data": {"data": data, "mime_type": mime_type}})
                    
                    if parts:
                        history.append({"role": role, "parts": parts})

                if not history:
                    return

                # Initial generation
                response = client.models.generate_content(
                    model=MODEL_ID,
                    contents=history,
                    config=types.GenerateContentConfig(tools=[{"function_declarations": TOOL_DECLARATIONS}])
                )

                # Recursive tool handling loop with Permission Relay
                while response.candidates[0].content.parts[0].function_call:
                    tool_call = response.candidates[0].content.parts[0].function_call
                    tool_name = tool_call.name
                    tool_args = tool_call.args
                    
                    # 1. Permission Check (Relay Pattern)
                    if tool_name in SENSITIVE_TOOLS:
                        # Request permission in Discord
                        prompt_msg = f"🛡️ **Permission Request**: `{tool_name}({tool_args})`\nReact with ✅ to approve or ❌ to deny."
                        request_msg = await channel.send(prompt_msg)
                        await request_msg.add_reaction("✅")
                        await request_msg.add_reaction("❌")

                        def check_reaction(reaction, user):
                            return user.id in ALLOWED_USERS and \
                                   str(reaction.emoji) in ["✅", "❌"] and \
                                   reaction.message.id == request_msg.id

                        try:
                            reaction, user = await self.wait_for('reaction_add', timeout=120.0, check=check_reaction)
                            if str(reaction.emoji) == "❌":
                                await request_msg.edit(content=f"🚫 **Permission Denied**: `{tool_name}` aborted.")
                                return
                            await request_msg.edit(content=f"✅ **Permission Granted**: `{tool_name}` executing...")
                        except asyncio.TimeoutError:
                            await request_msg.edit(content=f"⚠️ **Timeout**: Permission request for `{tool_name}` expired.")
                            return
                    
                    # 2. Execute tool
                    if tool_name in TOOLS:
                        result = TOOLS[tool_name](**tool_args)
                    else:
                        result = f"Error: Tool '{tool_name}' not found."
                    
                    print(f"Tool {tool_name} -> Result: {str(result)[:50]}...")

                    # Feed result back
                    history.append(response.candidates[0].content)
                    history.append({
                        "role": "user",
                        "parts": [{"function_response": {"name": tool_name, "response": {"result": str(result)}}}]
                    })
                    
                    response = client.models.generate_content(
                        model=MODEL_ID,
                        contents=history,
                        config=types.GenerateContentConfig(tools=[{"function_declarations": TOOL_DECLARATIONS}])
                    )

                await self.send_long_message(channel, response.text)
                try:
                    await trigger_message.remove_reaction("⏳", self.user)
                    await trigger_message.add_reaction("✅")
                except: pass

            except Exception as e:
                print(f"Gemini Processing Error: {e}")
                try:
                    await trigger_message.remove_reaction("⏳", self.user)
                    await trigger_message.add_reaction("❌")
                    await channel.send(f"⚠️ Error: {str(e)}")
                except: pass

    async def send_long_message(self, channel, text):
        if not text: return
        if len(text) <= 2000:
            await channel.send(text)
            return
        chunks = [text[i:i+1990] for i in range(0, len(text), 1990)]
        for chunk in chunks: await channel.send(chunk)

bot = GeminiBot(intents=intents)

if __name__ == '__main__':
    bot.run(DISCORD_TOKEN)