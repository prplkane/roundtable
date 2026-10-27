import test from 'node:test';
import assert from 'node:assert/strict';
import { groupQuestions, answerMessage, argumentHtml, remainingWindow, cancellationReason, stopExplanation } from '../src/review-view.js';

test('questions share an answer only when their wording matches; distinct questions and sources survive', () => {
  const questions = [{ lens: 'risk', question: 'What is the budget?' }, { lens: 'cost', question: '  What is the budget? ' }, { lens: 'evidence', question: 'Is the budget approved?' }];
  const grouped = groupQuestions(questions);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[0].sources, ['risk', 'cost']);
  const text = answerMessage(questions, [{ id: 'q1', text: 'Not decided.' }], 'Keep the pilot reversible.');
  assert.match(text, /Question \(risk, cost\): What is the budget\?\nAnswer: Not decided/);
  assert.ok(text.endsWith('Keep the pilot reversible.'));
  assert.doesNotMatch(text, /approved/);
  assert.throws(() => answerMessage(questions, [{ id: 'q9', text: 'value' }]), (e) => e.status === 409);
  assert.throws(() => answerMessage(questions, [{ id: 'q1', text: 'a' }, { id: 'q1', text: 'b' }]), (e) => e.status === 409);
});

test('argument emphasis escapes HTML, preserves wording and does not turn negated support green', () => {
  const input = 'I do not support <img src=x onerror=alert(1)>; don’t reject evidence.';
  const html = argumentHtml(input, 'disagree');
  assert.match(html, /term-disagree">not<\/strong>/);
  assert.match(html, /term-disagree">don’t<\/strong>/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.equal(argumentHtml('I do not support it', 'agree'), 'I do not support it');
  assert.match(argumentHtml('I support it', 'agree'), /term-agree">support<\/strong>/);
});

test('compact quota reports the limiting window, with no invented percentage for unknown usage', () => {
  assert.deepEqual(remainingWindow({ at: 100, windows: [{ label: '5h', used: .09 }, { label: '7d', used: .05 }] }), { at: 100, label: '5h', remaining: 91 });
  assert.equal(remainingWindow({ windows: [{ used: null }, { used: NaN }] }), null);
  assert.equal(remainingWindow({ windows: [{ used: 1.1, label: '5h' }] }).remaining, 0);
});

test('known cancellation differs from provider timeout, including old final-round records', () => {
  const reply = { failed: true, errorKind: 'killed', round: 1 };
  assert.equal(cancellationReason(reply, 'human', 1), 'human');
  assert.equal(cancellationReason(reply, 'wall-clock', 1), 'wall-clock');
  assert.equal(cancellationReason(reply, 'human', 2), null);
  assert.equal(cancellationReason({ ...reply, errorKind: 'timeout' }, 'human', 1), null);
  assert.match(stopExplanation('wall-clock', 'waiting'), /waiting for your input.*No answer was assumed/);
});
