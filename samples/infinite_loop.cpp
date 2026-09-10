int forever() {
    int i = 0;
    while (true) {
        i = i + 1;
        if (i > 1000000000) {
            i = 0;
        }
    }
    return i;
}

int main() {
    return forever();
}
