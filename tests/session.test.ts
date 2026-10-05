/**
 * Responsibility: verify LLMSession conversational continuity across actor-backed turns.
 * Scope: prior-turn injection and preservation of concrete tool observations; no actor execution semantics.
 * Rules: use a minimal fake actor and assert only the session contract.
 */
import {expect, test} from 'bun:test'
import type {Asker, ActorRunResult, LLMActor} from '../src/index.ts'
import {LLMSession} from '../src/index.ts'

test('LLMSession carries actor tool observations into the next actor turn', async () => {
    const goals: string[] = []
    let call = 0

    const actor = {
        async run(goal: string): Promise<ActorRunResult> {
            goals.push(goal)
            call += 1

            if (call === 1) {
                return {
                    ok: true,
                    finalText: 'The smallest folder is .ai.',
                    totalSteps: 2,
                    haltReason: 'completed',
                    steps: [
                        {
                            step: 1,
                            thought: 'internal reasoning must not become session history',
                            action: 'tool_call',
                            toolCalls: [{
                                callId: '1',
                                toolName: 'shell',
                                parameters: {command: 'du -d 1 ~/'},
                            }],
                            toolResults: [{
                                callId: '1',
                                toolName: 'shell',
                                isError: false,
                                result: {stdout: '0\\t/home/dharmax/.ai\\n', stderr: '', exitCode: 0},
                            }],
                        },
                        {
                            step: 2,
                            thought: 'answer',
                            action: 'final_answer',
                            toolCalls: [],
                            toolResults: [],
                            finalAnswer: 'The smallest folder is .ai.',
                        },
                    ],
                }
            }

            return {
                ok: true,
                finalText: 'No process is using it.',
                totalSteps: 1,
                haltReason: 'completed',
                steps: [{
                    step: 1,
                    thought: 'follow-up',
                    action: 'final_answer',
                    toolCalls: [],
                    toolResults: [],
                    finalAnswer: 'No process is using it.',
                }],
            }
        },
    } as unknown as LLMActor

    const session = new LLMSession({} as Asker)

    await session.run(actor, "what's the smallest folder under my home directory?")
    await session.run(actor, 'who is using that folder?')

    expect(goals[0]).toBe("what's the smallest folder under my home directory?")
    expect(goals[1]).toContain("what's the smallest folder under my home directory?")
    expect(goals[1]).toContain('/home/dharmax/.ai')
    expect(goals[1]).toContain('## Current User Goal\nwho is using that folder?')

    const history = session.getHistory()
    expect(history.some(message => message.content.includes('/home/dharmax/.ai'))).toBe(true)
    expect(history.some(message => message.content.includes('internal reasoning must not become session history'))).toBe(false)
})

test('LLMSession.appendMessage ingests external messages into session context', () => {
    const session = new LLMSession({} as Asker)
    session.appendMessage({ role: 'user', content: '!pwd' })
    session.appendMessage({ role: 'system', content: 'Direct command observation:\n!pwd -> /home/dharmax/work\n' })

    const history = session.getHistory()
    expect(history.length).toBe(2)
    expect(history[0]).toEqual({ role: 'user', content: '!pwd' })
    expect(history[1].content).toContain('/home/dharmax/work')
})


test('LLMSession bounds replayable history by character budget', () => {
    const session = new LLMSession({} as Asker, {maxHistoryChars: 60})
    session.appendMessage({role: 'user', content: 'first message that should be displaced'})
    session.appendMessage({role: 'system', content: 'latest observation is intentionally much longer than the remaining history budget'})

    const history = session.getHistory()
    const total = history.reduce((sum, message) => sum + message.content.length, 0)

    expect(total).toBeLessThanOrEqual(60)
    expect(history.at(-1)?.content).toContain('latest observation')
    expect(history.at(-1)?.content).toContain('[history truncated]')
})
