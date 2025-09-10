from openai import OpenAI

def get_or_create_assistant(user_api_key, cache):
    # Check if cache is initialized
    if cache is None:
        raise RuntimeError("Cache is not initialized. Ensure init_cache is called in krakenServer.py before using gpt_autofix.")
    
    # Check if assistant is in cache
    assistant = cache.get(f'assistant_{user_api_key}')
    
    if assistant is None:
        client = OpenAI(api_key=user_api_key)
        assistant = client.beta.assistants.create(
            name="AI Autofix Assistant",
            instructions=
"""
Hello. Im data scientist working with hand written recognition data from medieval Latin liturgical manuscripts. (until ca. 1300)

Below i will provide you a raw text from hand written ocr. It can contain <red> </red> tags that may inform about a new rubric, rite name or may be some shortcuts of the ends of prayers.
<func></func> tag can contain a prayer function (discribed below).
Sometimes function is also assigned as <red> and this need to be fixed by you.

I want you to fix this text and tags. You should use knowledge of known Latin words, phrases and of course prayers, liturgical ceremony, saints etc, to make this text better.
Use prayers from the critical sources and corpus orationem if you know it.
If you notice that text is missing or the ending or begging is missing - feel free to add it.
Also you should fix the <red> and <func> tags. You can remove them if you think that algorithm mark them by mistake, you can modify them or add them.
I want only rite names to be inside <red> tags.

If you notice a prayer function like one of this:
[Apologia, Ordo feriae quintae, Scrutinium, Breuiarum apostolorum, Iudicium Paenitentiale, Rubrica, Per ipsum, Per haec omnia, Nobis quoque peccatoribus, Supplices te rogamus, Supra que, Unde et memores, Quam oblationem, Memento Domine, Te igitur, Uere dignum et iustum est, Sursum corda, Consecratio, Ordo de feria quinta, Qui pridie, Pater noster, Expositio praefatio symboli, Expositio euangeliorum, Memento, Hanc igitur, Ordinatio, Ordo de sabbato sancto, Ordo baptismi, Oratio sollemnis, Ordo de feria sexta, Ordo de feria quinta, Ordo paenitentiae, Exorcismus, Ad populum, Post communionem, Prophetia	Lect, Lectio, Exsultet, Oratio, Calendarium, Infra actionem	Canon miss, Psalmus, Versus, Antiphona, Sanctus, Capitulum, Benedictio, Super populum, Communicantes, EMPTY PAGES, Agnus dei, Canon missae, Martirologium, Ad complendum, Prefatio, Secreta, Collecta]
please contain it in a <func></func> tag.
Prayer function typically should be before the prayer, not in the middle of it.

You should not print, say or comment anything but the correct text. This is authonomic process, so if you say anything but text, your words will be saved as a prayer, so don't do it.

If you don't know how to fix the text - just print it as is. Do not comment that fact.

In the following messages always remember rules from above.
""",
            tools=[{"type": "code_interpreter"}],
            model="gpt-4o",
        )
        # Cache the assistant instance with a timeout (e.g., 24*1 hour)
        cache.set(f'assistant_{user_api_key}', assistant, timeout=24*3600)
    return assistant

def gpt_autofix(question, user_api_key, cache):
    response = {
        'text': "",
        'error': ""
    }
    try:
        # Get or create the assistant for the user
        assistant = get_or_create_assistant(user_api_key, cache)

        # Create a new thread for the user
        client = OpenAI(api_key=user_api_key)
        thread = client.beta.threads.create()

        message = client.beta.threads.messages.create(
            thread_id=thread.id,
            role="user",
            content=question
        )

        run = client.beta.threads.runs.create_and_poll(
            thread_id=thread.id,
            assistant_id=assistant.id,
        )

        if run.status == 'completed': 
            messages = client.beta.threads.messages.list(
                thread_id=thread.id
            )
            print("-------------RAW MSG------------")
            for msg in messages:
                print(msg)

                if msg.assistant_id and len(msg.assistant_id) > 1:
                    full_mess = msg.content[0].text.value
                    response['text'] = full_mess
                    break
        else:
            response['error'] = str(run.status)
            print(run.status)
    except Exception as e:
        response['error'] = str(e)
        print(f"Error in gpt_autofix: {str(e)}")

    return response