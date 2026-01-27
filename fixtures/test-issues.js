// Test file with various SonarQube issues

var x = 1; // Should use let/const instead of var
console.log("Hello world"); // console.log usage
var unusedVariable = "not used"; // Unused variable

function testFunction() {
    var y = 2; // var in function
    if (x == 1) { // Should use === instead of ==
        console.log("x is 1")
    }
    return y
} // Missing semicolon

// Empty block
if (true) {
}

var result = testFunction();
