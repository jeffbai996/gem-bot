import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGY_MODEL_CHOICES,
  API_MODEL_CHOICES,
  DEFAULT_AGY_MODEL,
  DEFAULT_GEMINI_MODEL,
  friendlyModelName,
  isValidAgyModel,
  modelEffort,
} from '../src/models.ts'

test('Gemini 3.7 Flash is the default and first API choice', () => {
  assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.7-flash')
  assert.equal(API_MODEL_CHOICES[0].value, DEFAULT_GEMINI_MODEL)
  assert.equal(API_MODEL_CHOICES.map(choice => String(choice.value)).includes('gemini-3-pro-preview'), false)
  assert.equal(API_MODEL_CHOICES.some(choice => String(choice.value).startsWith('gemini-3.5')), false)
  // Superseded flash tiers must not linger in the picker.
  assert.equal(API_MODEL_CHOICES.some(choice => String(choice.value).startsWith('gemini-3.6')), false)
})

test('Antigravity uses the exact current 3.7 CLI ids', () => {
  assert.equal(DEFAULT_AGY_MODEL, 'gemini-3.7-flash-medium')
  assert.equal(AGY_MODEL_CHOICES[0].value, DEFAULT_AGY_MODEL)
  assert.equal(isValidAgyModel('gemini-3.7-flash-high'), true)
  assert.equal(isValidAgyModel('Gemini 3.7 Flash (High)'), false)
  assert.equal(isValidAgyModel('gemini-3.6-flash-high'), false)
  assert.equal(AGY_MODEL_CHOICES.some(choice => String(choice.value).startsWith('gemini-3.5')), false)
  assert.equal(AGY_MODEL_CHOICES.some(choice => String(choice.value).startsWith('gemini-3.6')), false)
})

test('model labels and effort work for API and Antigravity ids', () => {
  assert.equal(friendlyModelName('gemini-3.7-flash'), 'Gemini 3.7 Flash')
  assert.equal(friendlyModelName('gemini-3.7-flash-medium'), 'Gemini 3.7 Flash (Medium)')
  assert.equal(modelEffort('gemini-3.7-flash-medium'), 'medium')
  assert.equal(modelEffort('Gemini 3.7 Flash (High)'), 'high')
  // A 3.6 pin persisted before the cutover still renders as a name, not a slug.
  assert.equal(friendlyModelName('gemini-3.6-flash'), 'Gemini 3.6 Flash')
})
