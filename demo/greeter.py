def greet(name):
    """Return a greeting for the given name."""
    return f"Hello, {name}!"


def farewell(name):
    return f"Goodbye, {name}!"


if __name__ == "__main__":
    print(greet("world"))
    print(farewell("world"))
