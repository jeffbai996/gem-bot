// Must be the first import of the entry file: shared modules read their
// env namespace at load time (see squad-bot-kit/env.ts). gem grew three
// spellings; all three keep working, first match wins.
process.env.SQUAD_BOT_ENV_PREFIX ??= 'GEMINI,GEMMA,GEM'
