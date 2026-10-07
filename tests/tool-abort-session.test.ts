import {test, expect} from 'bun:test'
import {Asker, CompletionEngine, LLMActor, LLMSession, ToolAbortError, z, type ActorRunResult} from '../src/index.ts'

function fixture(decisions: unknown[]) {
    const prompts: string[] = []
    const completion = new CompletionEngine([]).registerAdapter({id: 'mock', async generate(prompt) {
        prompts.push(prompt.prompt)
        return {ok:true, text:JSON.stringify(decisions[prompts.length - 1]), model:{providerId:'mock',modelId:'fixture'}}
    }})
    return {prompts, asker:new Asker({providers:{mock:{id:'mock',available:true}},completion,defaultModel:'mock/fixture'})}
}

test('explicit refusal stops all remaining calls and alternate attempts', async () => {
    const {asker,prompts} = fixture([
        {thought:'private',action:'tool_call',toolCalls:[{name:'refused',parameters:{}},{name:'alternate',parameters:{}}]},
        {thought:'private',action:'final_answer',finalAnswer:'Fabricated success'},
    ])
    let alternate = 0
    const actor = new LLMActor(asker,{tools:[
        {name:'refused',description:'refused',parameters:z.object({}),execute(){throw new ToolAbortError('Aborted by user.')}},
        {name:'alternate',description:'alternate',parameters:z.object({}),execute(){alternate++;return 'success'}},
    ]})
    const result = await actor.run('Inspect the GPU')
    expect(result).toMatchObject({ok:false,haltReason:'aborted',error:'Aborted by user.'})
    expect(result.steps[0].toolResults).toHaveLength(1)
    expect(result.steps[0].toolResults[0]).toMatchObject({isError:true,error:'Aborted by user.'})
    expect(alternate).toBe(0); expect(prompts).toHaveLength(1)
})

test('ordinary tool failure is visible and remains recoverable', async () => {
    const {asker,prompts} = fixture([
        {thought:'private',action:'tool_call',toolCalls:[{name:'read',parameters:{}}]},
        {thought:'private',action:'tool_call',toolCalls:[{name:'read',parameters:{}}]},
        {thought:'private',action:'final_answer',finalAnswer:'Observed load is 12%.'},
    ])
    let calls = 0
    const actor = new LLMActor(asker,{tools:[{name:'read',description:'read',parameters:z.object({}),execute(){
        if (++calls === 1) throw new Error('Temporary transport failure')
        return 'GPU load 12%'
    }}]})
    const result = await actor.run('Inspect the GPU')
    expect(result.ok).toBe(true); expect(calls).toBe(2)
    expect(prompts[1]).toContain('Temporary transport failure')
    expect(result.steps[0].toolResults[0].isError).toBe(true)
    expect(result.steps[1].toolResults[0].isError).toBe(false)
})

for (const haltReason of ['completed','error','aborted'] as const) test('session stores raw input and observations on ' + haltReason, async () => {
    const goals: string[] = []
    const actor = {async run(goal:string):Promise<ActorRunResult> {
        goals.push(goal)
        return {ok:haltReason==='completed',haltReason,issues:[],totalSteps:1,finalText:'Answer',error:haltReason==='completed'?undefined:'Aborted by user.',steps:[{
            step:1,thought:'PRIVATE REASONING',action:'tool_call',toolCalls:[{callId:'c',toolName:'shell',parameters:{command:'ssh lotus nvidia-smi'}}],
            toolResults:[{callId:'c',toolName:'shell',isError:haltReason!=='completed',result:'GPU load 12%',error:'Aborted by user.'}],
        }]}
    }} as unknown as LLMActor
    const session = new LLMSession({} as Asker)
    await session.run(actor,'INTERNAL COMPILED GOAL',{userInput:"what's the load of lotus machine's gpu right now?"})
    const history = session.history
    expect(history[0].content).toBe("what's the load of lotus machine's gpu right now?")
    expect(JSON.stringify(history)).not.toContain('INTERNAL COMPILED GOAL')
    expect(JSON.stringify(history)).not.toContain('PRIVATE REASONING')
    if (haltReason !== 'completed') expect(history.some(m=>m.role==='ai')).toBe(false)
    await session.run(actor,'try again')
    expect(goals[1]).toContain("what's the load of lotus machine's gpu right now?")
    expect(goals[1]).toContain('ssh lotus nvidia-smi')
    if (haltReason !== 'completed') expect(goals[1]).toContain('Aborted by user.')
})
