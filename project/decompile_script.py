
from ghidra.program.model.listing import Program
from ghidra.app.decompiler import DecompInterface

program = getCurrentProgram()
decompiler = DecompInterface()
decompiler.openProgram(program)

output_file = r"C:\contract - Copy\decompiled_code.txt"
with open(output_file, "w") as f:
    function_manager = program.getFunctionManager()
    for function in function_manager.getFunctions(True):
        decompiled_function = decompiler.decompileFunction(function, 30, monitor)
        if decompiled_function.decompileCompleted():
            f.write(f"Function: {function.getName()}\n")
            f.write(decompiled_function.getDecompiledFunction().getC())
            f.write("\n\n")
print(f"Decompiled code saved to {output_file}")
